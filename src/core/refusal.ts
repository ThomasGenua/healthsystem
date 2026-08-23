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
 * detail on the audit row and the log.
 */
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
  /** What the trail and the log see. Always the real message. */
  detail: string;
}

export function mapStoreError(err: unknown): MappedStoreError {
  if (err instanceof Refusal) {
    return { status: err.status, error: err.message, outcome: 4, detail: err.message };
  }
  const detail = err instanceof Error ? err.message : String(err);
  return { status: 500, error: "internal error", outcome: 8, detail };
}
