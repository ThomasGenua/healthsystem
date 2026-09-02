/**
 * A store saying no, as distinct from a store falling over.
 *
 * `phi()` used to map every throw to HTTP 400 and audit outcome 8. A full
 * slot, a malformed request and a disk error then looked the same to a
 * caller — and a client that retries on 5xx and gives up on 4xx would give
 * up on a transient fault. The exception message also went out verbatim,
 * which is useful for a refusal written to be read and not useful for an
 * unexpected stack.
 *
 * A `Refusal` is a decision. Anything else is a fault: 500, generic body,
 * detail on the audit row — and, in the log, an id that reaches that row
 * rather than the message, which is the part that can carry a patient in it.
 */
import { randomUUID } from "node:crypto";

export class Refusal extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "Refusal";
    this.status = status;
  }
}

/** Throw a refusal. The stores use this instead of `throw new Error` for a no. */
export function refuse(message: string, status = 400): never {
  throw new Refusal(message, status);
}

export interface MappedStoreError {
  status: number;
  /** What the caller sees. */
  error: string;
  /** FHIR AuditEvent outcome: 4 minor (refused), 8 serious (fault). */
  outcome: 4 | 8;
  /** What the trail sees. Always the real message. */
  detail: string;
  /**
   * Set on a fault only. The one thing about a fault that is safe to say
   * anywhere: an opaque id carrying no information of its own, printed in
   * the log and returned to the caller so a report of "it broke" can be
   * turned into the trail row that says how.
   */
  faultId?: string;
}

export function mapStoreError(err: unknown): MappedStoreError {
  if (err instanceof Refusal) {
    return { status: err.status, error: err.message, outcome: 4, detail: err.message };
  }
  const faultId = randomUUID();
  const detail = err instanceof Error ? err.message : String(err);
  // The id goes on the trail row too, because the correlation is only useful
  // in the direction it is needed: from a log line nobody can read to the
  // row that explains it.
  return { status: 500, error: "internal error", outcome: 8, detail: `fault ${faultId}: ${detail}`, faultId };
}

/**
 * What a fault is allowed to say out loud.
 *
 * An exception message is the part of a fault that can carry a patient's
 * data. `${open.length} medication(s) still undecided: ${names}` and
 * `result is for ${a} but order is for ${b}` were both thrown as plain
 * errors, so both reached `console.error` and, from there, whatever
 * collects stdout — which is not a system anyone treats as holding PHI.
 *
 * So the log gets the class and the code path, which say where to look
 * without saying what was being looked at, and the message stays on the
 * trail behind the fault id. Stack frames are `at <function> (<file>:<line>)`:
 * identifiers and positions, never values. The first line of `err.stack` is
 * dropped precisely because it repeats the message.
 */
export function faultLine(faultId: string, err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const frames =
    err instanceof Error && typeof err.stack === "string"
      ? err.stack
          .split("\n")
          .filter((line) => /^\s+at /.test(line))
          .slice(0, 3)
          .map((line) => line.trim())
          .join(" <- ")
      : "";
  return frames ? `fault ${faultId} ${name} ${frames}` : `fault ${faultId} ${name}`;
}

/**
 * Prints a fault, and nothing about a refusal.
 *
 * A helper rather than a `console.error` at each site because the mistake
 * this replaces was easy to make and invisible once made: the detail was
 * right there on the mapped error, it read like the useful field, and
 * passing it logged the message. There is now nothing at a call site to
 * pass wrongly.
 */
export function logFault(where: string, mapped: MappedStoreError, err: unknown): void {
  if (mapped.outcome !== 8) return;
  console.error(`${where}: ${faultLine(mapped.faultId ?? "unrecorded", err)}`);
}

/**
 * As much of a request path as is safe to print.
 *
 * `/fhir/Patient/NT123456`, `/patient/NT123456/summary` and
 * `/api/keys/<key>/rotate` all put an identifier in the path, so the net
 * under the router cannot log the path a fault arrived on. Every rule for
 * spotting "the id segment" by its shape is a guess about somebody else's
 * identifier format — a lowercase alphanumeric patient id looks exactly
 * like a route word — so this does not guess at shapes. It uses the one
 * thing that is known: where this router puts its identifiers.
 *
 * Under `/api` the second segment is always an area (`clinical`, `keys`,
 * `health`); under `/fhir` it is always a resource type. Everywhere else —
 * `/patient/<id>`, `/ingest/<channel>` — the second segment is already an
 * identifier, so one segment is all that can be said.
 *
 * A route family added later and not listed here logs one segment instead
 * of two: less useful, never unsafe, which is the direction this has to
 * fail in. The stack frames in `faultLine` name the function and the line
 * anyway, which is the more precise answer.
 */
const TWO_SEGMENT_AREAS = new Set(["api", "fhir"]);

export function routeArea(path: string): string {
  const segments = path.split("/").filter((s) => s !== "");
  if (segments.length === 0) return "/";
  const depth = TWO_SEGMENT_AREAS.has(segments[0]) ? 2 : 1;
  return "/" + segments.slice(0, depth).join("/");
}

/** The body a mapped error is safe to send. A fault carries its id, not its message. */
export function errorBody(mapped: MappedStoreError): { error: string; faultId?: string } {
  return mapped.faultId ? { error: mapped.error, faultId: mapped.faultId } : { error: mapped.error };
}
