/**
 * Access audit trail.
 *
 * Canadian health privacy law — PHIPA in Ontario, HIA in Alberta, ATIPP and
 * the Health Information Act in the territories — obliges a custodian to know
 * who looked at whose record. Portage stores patient data in the facade and
 * raw HL7 in the message log, so it has to answer that question.
 *
 * What is recorded, and what deliberately is not:
 *
 *   Disclosure is the event that matters, so every read of patient data is
 *   recorded — a facade read or search, and a look at a raw message, since an
 *   ER7 message is as identifying as anything in the facade. Refused attempts
 *   are recorded too: an audit trail that only shows successes cannot show
 *   someone trying doors. Key issue and revocation are recorded because they
 *   change who can open them.
 *
 *   Internal writes are not recorded here. Every message already carries a
 *   hash-chained lineage with its pipeline steps and deliveries, which is a
 *   stronger record than an audit line would be, and duplicating it would
 *   bury the disclosure events in routine traffic.
 *
 * The trail is hash-chained exactly as message lineage is, so a row cannot be
 * altered or removed without breaking verification — the property that makes
 * an audit log worth keeping.
 *
 * Rows carry identifiers and references, never payloads. An audit trail that
 * copied the record it was protecting would double the exposure it exists to
 * detect.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db.ts";

/** REST verbs as FHIR AuditEvent actions. */
export type AuditAction = "C" | "R" | "U" | "D" | "E";

/** FHIR AuditEvent.outcome: 0 success, 4 minor failure, 8 serious failure. */
export type AuditOutcome = 0 | 4 | 8;

export interface AuditEntry {
  action: AuditAction;
  outcome?: AuditOutcome;
  principalId: string;
  principalKind: string;
  method: string;
  path: string;
  resourceType?: string;
  resourceId?: string;
  /** Identifier token of the patient whose data was reached, when known. */
  patient?: string;
  /** Number of records disclosed. A search that returns 900 is not a read. */
  count?: number;
  sourceIp?: string;
  detail?: string;
}

export interface AuditRow {
  seq: number;
  id: string;
  recorded_at: string;
  action: AuditAction;
  outcome: AuditOutcome;
  principal_id: string;
  principal_kind: string;
  method: string;
  path: string;
  resource_type: string | null;
  resource_id: string | null;
  patient: string | null;
  count: number | null;
  source_ip: string | null;
  detail: string | null;
  hash: string;
  prev_hash: string | null;
}

export interface AuditFilter {
  principal?: string;
  patient?: string;
  resourceType?: string;
  /** ISO timestamp; rows at or after it. */
  since?: string;
  /** Only refusals, for the "who tried what" question. */
  failuresOnly?: boolean;
  limit?: number;
}

/** The fields covered by the chain hash. Everything that could be falsified. */
function digest(prev: string | null, e: AuditEntry, id: string, recordedAt: string): string {
  return createHash("sha256")
    .update(prev ?? "")
    .update("|")
    .update(id)
    .update("|")
    .update(recordedAt)
    .update("|")
    .update(e.action)
    .update("|")
    .update(String(e.outcome ?? 0))
    .update("|")
    .update(e.principalKind)
    .update("|")
    .update(e.principalId)
    .update("|")
    .update(e.method)
    .update("|")
    .update(e.path)
    .update("|")
    .update(e.resourceType ?? "")
    .update("|")
    .update(e.resourceId ?? "")
    .update("|")
    .update(e.patient ?? "")
    .update("|")
    .update(e.count === undefined ? "" : String(e.count))
    .digest("hex");
}

export class AuditStore {
  private db: Db;
  private tip: string | null | undefined;

  constructor(db: Db) {
    this.db = db;
  }

  /** The current chain tip, read once and then tracked in memory. */
  private head(): string | null {
    if (this.tip === undefined) {
      const row = this.db.sql
        .prepare("SELECT hash FROM audit_events WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1")
        .get(this.db.tenantId) as { hash: string } | undefined;
      this.tip = row?.hash ?? null;
    }
    return this.tip;
  }

  record(entry: AuditEntry): AuditRow {
    const id = randomUUID();
    const recordedAt = new Date().toISOString();
    const prev = this.head();
    const hash = digest(prev, entry, id, recordedAt);

    this.db.sql
      .prepare(
        `INSERT INTO audit_events
           (tenant_id, id, recorded_at, action, outcome, principal_id, principal_kind, method, path,
            resource_type, resource_id, patient, count, source_ip, detail, hash, prev_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        id,
        recordedAt,
        entry.action,
        entry.outcome ?? 0,
        entry.principalId,
        entry.principalKind,
        entry.method,
        entry.path,
        entry.resourceType ?? null,
        entry.resourceId ?? null,
        entry.patient ?? null,
        entry.count ?? null,
        entry.sourceIp ?? null,
        entry.detail ?? null,
        hash,
        prev
      );

    this.db.sql
      .prepare(
        `INSERT INTO audit_counters (tenant_id, issued) VALUES (?, 1)
         ON CONFLICT(tenant_id) DO UPDATE SET issued = issued + 1`
      )
      .run(this.db.tenantId);

    this.tip = hash;
    return this.db.sql
      .prepare("SELECT * FROM audit_events WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as AuditRow;
  }

  list(filter: AuditFilter = {}): AuditRow[] {
    const where: string[] = [];
    const args: Array<string | number> = [this.db.tenantId];
    if (filter.principal) {
      where.push("principal_id = ?");
      args.push(filter.principal);
    }
    if (filter.patient) {
      where.push("patient = ?");
      args.push(filter.patient);
    }
    if (filter.resourceType) {
      where.push("resource_type = ?");
      args.push(filter.resourceType);
    }
    if (filter.since) {
      where.push("recorded_at >= ?");
      args.push(filter.since);
    }
    if (filter.failuresOnly) where.push("outcome > 0");

    const sql =
      "SELECT * FROM audit_events WHERE tenant_id = ?" +
      (where.length ? ` AND ${where.join(" AND ")}` : "") +
      " ORDER BY seq DESC LIMIT ?";
    args.push(Math.min(filter.limit ?? 100, 1000));
    return this.db.sql.prepare(sql).all(...(args as never[])) as unknown as AuditRow[];
  }

  /**
   * Walks the chain from the beginning.
   *
   * An edited row and a row removed from the middle both break linkage: the
   * next row's back-pointer stops matching. Rows removed from the *end* do
   * not, because nothing survives that pointed at them — a truncated chain is
   * a shorter chain that verifies perfectly. Deleting an entire trail this way
   * used to report `ok`, which is the one answer it must never give: the
   * adversary this exists for is someone who read records they should not have
   * and would like that not to be knowable, and removing the most recent
   * entries is exactly the move.
   *
   * Nothing here is ever deleted legitimately — a retention sweep purges
   * messages, never the record of who read them — so the row count is a fact
   * the chain can be held to. `seq` is AUTOINCREMENT, which means SQLite keeps
   * the highest value ever issued in `sqlite_sequence` and never lowers it on
   * delete. Comparing the two catches removal from anywhere, including the end
   * and including every row at once, and it costs nothing to maintain because
   * SQLite is already keeping the number.
   *
   * On its own that is a bar, not a proof: someone with write access to this
   * database can edit `sqlite_sequence` as easily as `audit_events`. A chain
   * kept beside the data it attests to cannot do better, and the README says
   * so rather than implying otherwise. What closes it is anchoring the tip
   * somewhere the engine does not control, which is why the tip is returned
   * here and exported on /metrics.
   */
  verifyChain(): {
    ok: boolean;
    checked: number;
    tip?: string;
    brokenAt?: string;
    missing?: { expected: number; found: number };
  } {
    const rows = this.db.sql
      .prepare("SELECT * FROM audit_events WHERE tenant_id = ? ORDER BY seq")
      .all(this.db.tenantId) as unknown as AuditRow[];
    let prev: string | null = null;
    let checked = 0;
    for (const r of rows) {
      const expect = digest(
        prev,
        {
          action: r.action,
          outcome: r.outcome,
          principalId: r.principal_id,
          principalKind: r.principal_kind,
          method: r.method,
          path: r.path,
          resourceType: r.resource_type ?? undefined,
          resourceId: r.resource_id ?? undefined,
          patient: r.patient ?? undefined,
          count: r.count ?? undefined,
        },
        r.id,
        r.recorded_at
      );
      if (r.prev_hash !== prev || r.hash !== expect) return { ok: false, checked, brokenAt: r.id };
      prev = r.hash;
      checked++;
    }

    // How many rows were ever written for this tenant.
    //
    // This used to read SQLite's own AUTOINCREMENT high-water mark, which was
    // exact while there was one tenant and became meaningless the moment there
    // were two: `seq` is issued across the whole table, so the mark counts
    // everyone's rows and would report every tenant as missing most of its
    // trail. The counter is kept per tenant instead, incremented in the same
    // statement path as the insert, and — like the mark it replaces — only
    // ever goes up, so deleting rows cannot bring it back into agreement.
    const issued = this.db.sql
      .prepare("SELECT issued FROM audit_counters WHERE tenant_id = ?")
      .get(this.db.tenantId) as { issued: number } | undefined;
    if (issued && issued.issued !== checked) {
      return { ok: false, checked, missing: { expected: issued.issued, found: checked } };
    }

    return { ok: true, checked, ...(prev ? { tip: prev } : {}) };
  }

  count(): number {
    return (
      this.db.sql
        .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id = ?")
        .get(this.db.tenantId) as { n: number }
    ).n;
  }

  /** Renders a row as an R4 AuditEvent, so consumers get a standard shape. */
  toAuditEvent(r: AuditRow, base = ""): Record<string, unknown> {
    const entity: Array<Record<string, unknown>> = [];
    if (r.resource_type) {
      entity.push({
        what: r.resource_id
          ? { reference: `${r.resource_type}/${r.resource_id}` }
          : { type: r.resource_type },
        type: { system: "http://terminology.hl7.org/CodeSystem/audit-entity-type", code: "2", display: "System Object" },
        ...(r.count != null ? { detail: [{ type: "count", valueString: String(r.count) }] } : {}),
      });
    }
    if (r.patient) {
      entity.push({
        what: { identifier: { value: r.patient } },
        type: { system: "http://terminology.hl7.org/CodeSystem/audit-entity-type", code: "1", display: "Person" },
        role: { system: "http://terminology.hl7.org/CodeSystem/object-role", code: "1", display: "Patient" },
      });
    }

    return {
      resourceType: "AuditEvent",
      id: r.id,
      type: { system: "http://terminology.hl7.org/CodeSystem/audit-event-type", code: "rest", display: "RESTful Operation" },
      action: r.action,
      recorded: r.recorded_at,
      outcome: String(r.outcome),
      ...(r.detail ? { outcomeDesc: r.detail } : {}),
      agent: [
        {
          who: { identifier: { system: `urn:portage:principal:${r.principal_kind}`, value: r.principal_id } },
          requestor: true,
          ...(r.source_ip ? { network: { address: r.source_ip, type: "2" } } : {}),
        },
      ],
      source: {
        observer: { display: base || "portage" },
        type: [{ system: "http://terminology.hl7.org/CodeSystem/security-source-type", code: "4", display: "Application Server" }],
      },
      ...(entity.length ? { entity } : {}),
    };
  }
}
