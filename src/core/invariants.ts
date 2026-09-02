/**
 * What the database is supposed to be true of itself.
 *
 * `SCHEMA has no REFERENCES today`, as the migration comment says, so
 * `PRAGMA foreign_keys = ON` enforces nothing: every link between two tables
 * here is held together by application code. And the tenant boundary is not
 * a database at all — it is a column that every query is expected to name.
 * Both are conventions, both are correct today because a structural test
 * reads the source and says so, and neither has ever been checked against
 * the rows actually stored.
 *
 * Those are different questions. The source check says the queries written
 * so far are scoped. It cannot speak for a database that was restored from
 * two sites' snapshots, edited outside Northstar, migrated by a script
 * somebody wrote once, or written by a version of this code from before the
 * check existed. A row in one custodian's chart pointing at another
 * custodian's record produces no error at any layer: every tenant-bound read
 * simply returns it, or simply does not.
 *
 * So this reads the data and answers three things:
 *
 *   - **Every row has a tenant.** A row with none is invisible to every
 *     tenant-bound query — it exists, it is in the backups, it is counted by
 *     the retention sweep, and no clinician can see it.
 *   - **Every reference resolves, and resolves inside its own tenant.**
 *     Reported as two different findings, because they are two different
 *     incidents: an orphan is data loss, and a reference that resolves in
 *     another custodian's data is a disclosure.
 *   - **The chains that must stay linear are linear.** A partial unique index
 *     enforces this from the moment it exists, which is not the same as
 *     always; a database that predates one, or that has been edited under
 *     the engine, can hold what the index would now refuse.
 *
 * ## Fail closed, and say so
 *
 * The one outcome this must never produce is a clean report for a check it
 * did not run. Every entry in the registry is resolved against
 * `PRAGMA table_info` first, and a check naming a table or column this
 * database does not have is `unevaluated` with the reason — never `pass`.
 * Four scanners in this repository have been found reporting less than they
 * claimed; the mechanism that catches that here is that a fresh schema must
 * evaluate every registered check, which its own test asserts.
 *
 * `examined` is reported beside every result for the same reason: a pass
 * over no rows and a pass over forty thousand are not the same evidence.
 *
 * ## Read-only
 *
 * Nothing here writes. Every statement is a SELECT, which is what lets an
 * operator point this at a live node or at a restored backup without
 * thinking about it.
 */
import type { DatabaseSync } from "node:sqlite";
import { TENANT_SCOPED_TABLES } from "../db.ts";

export type Outcome = "pass" | "violated" | "unevaluated";

export interface Violation {
  table: string;
  /** Which row, and nothing else from it. */
  row: string;
  tenant: string;
  detail: string;
}

export interface InvariantResult {
  name: string;
  outcome: Outcome;
  /** Rows the check looked at. A pass over nothing is not the same evidence as a pass over everything. */
  examined: number;
  violations: Violation[];
  /** Why it did not run. Present only when `unevaluated`. */
  reason?: string;
}

export interface Report {
  ok: boolean;
  checked: number;
  violated: InvariantResult[];
  unevaluated: InvariantResult[];
  results: InvariantResult[];
}

/**
 * A link one table makes to another, held together by nothing but the code
 * that writes it.
 *
 * An empty value is skipped rather than treated as dangling: an unsolicited
 * lab result has no order until somebody files it against one, and a
 * medication statement that came from no reconciliation names none. A
 * populated value that resolves nowhere is a finding whatever the column.
 */
export interface Link {
  child: string;
  column: string;
  parent: string;
  key: string;
}

/**
 * The links checked, and the reason this list is hand-written rather than
 * derived.
 *
 * Derivation would have to guess: `patient_id` names a chart in
 * `clinical_entries` and a person nothing in this database holds a row for in
 * `care_team`, and `actor_id` names a practitioner who may be a directory
 * entry, an API credential, or a string a device sent. A guess that is wrong
 * in the permissive direction reports a clean database; one that is wrong in
 * the strict direction reports violations that are not, which is how a check
 * stops being run. So this names only links where the child row is
 * meaningless without its parent, and where the parent is unambiguously one
 * table.
 */
export const LINKS: Link[] = [
  // The pipeline. A step or a delivery without its message is a record of
  // something that happened to nothing.
  { child: "message_steps", column: "message_id", parent: "messages", key: "id" },
  { child: "deliveries", column: "message_id", parent: "messages", key: "id" },

  // Orders. An event or a transmission against an order nobody holds is a
  // requisition that cannot be traced back to who asked for it.
  { child: "order_events", column: "order_id", parent: "orders", key: "id" },
  { child: "order_transmissions", column: "order_id", parent: "orders", key: "id" },
  { child: "order_results", column: "order_id", parent: "orders", key: "id" },

  // Medications. A dispense against a prescription nobody holds is a drug
  // that left a pharmacy with no order behind it.
  { child: "prescriptions", column: "statement_id", parent: "medication_statements", key: "id" },
  { child: "prescription_events", column: "prescription_id", parent: "prescriptions", key: "id" },
  { child: "prescription_dispenses", column: "prescription_id", parent: "prescriptions", key: "id" },
  { child: "med_reconciliation_items", column: "reconciliation_id", parent: "med_reconciliations", key: "id" },
  { child: "med_reconciliation_items", column: "statement_id", parent: "medication_statements", key: "id" },

  // Scheduling. A booking whose slot is in another custodian's calendar is
  // the shape of cross-tenant leak this exists to find.
  { child: "schedule_bookings", column: "slot_id", parent: "schedule_slots", key: "id" },
  { child: "schedule_events", column: "booking_id", parent: "schedule_bookings", key: "id" },
  { child: "schedule_offers", column: "waitlist_id", parent: "schedule_waitlist", key: "id" },
  { child: "schedule_offers", column: "slot_id", parent: "schedule_slots", key: "id" },

  // Encounters, referrals, tasks: an event log that outlives what it logs.
  { child: "encounter_participants", column: "encounter_id", parent: "encounters", key: "id" },
  { child: "encounter_events", column: "encounter_id", parent: "encounters", key: "id" },
  { child: "referral_events", column: "referral_id", parent: "referrals", key: "id" },
  { child: "task_events", column: "task_id", parent: "tasks", key: "id" },

  // The patient-facing surfaces, where a cross-tenant reference is a
  // disclosure rather than an inconsistency.
  { child: "patient_messages", column: "thread_id", parent: "patient_threads", key: "id" },
  { child: "patient_thread_events", column: "thread_id", parent: "patient_threads", key: "id" },
  { child: "patient_request_events", column: "request_id", parent: "patient_requests", key: "id" },
  { child: "privacy_review_events", column: "review_id", parent: "privacy_reviews", key: "id" },
  { child: "privacy_flags", column: "review_id", parent: "privacy_reviews", key: "id" },

  // The approval chain, whose links are the reason a score is enabled.
  { child: "score_approvals", column: "supersedes", parent: "score_approvals", key: "id" },
];

/** How many violations of one kind are listed before the count stands in for the rest. */
const MAX_LISTED = 20;

function columnsOf(sql: DatabaseSync, table: string): string[] {
  try {
    const rows = sql.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  } catch {
    // A table this database does not have. Reported by the caller as
    // unevaluated, which is the whole point of asking first.
    return [];
  }
}

/**
 * The column that names a row well enough to go and look at it.
 *
 * `messages` is keyed by `seq` and everything else by `id`, and a violation
 * an operator cannot locate is a violation they cannot fix.
 */
function rowKey(columns: string[]): string | null {
  if (columns.includes("id")) return "id";
  if (columns.includes("seq")) return "seq";
  return null;
}

/** Every row carries a tenant it can be found under. */
function checkTenants(sql: DatabaseSync): InvariantResult[] {
  return TENANT_SCOPED_TABLES.map((table): InvariantResult => {
    const columns = columnsOf(sql, table);
    if (columns.length === 0) {
      return { name: `tenant/${table}`, outcome: "unevaluated", examined: 0, violations: [], reason: "no such table" };
    }
    if (!columns.includes("tenant_id")) {
      return {
        name: `tenant/${table}`,
        outcome: "unevaluated",
        examined: 0,
        violations: [],
        reason: "no tenant_id column, though the table is declared tenant-scoped",
      };
    }
    const key = rowKey(columns);
    // crosses-tenants: the question is which rows have no tenant at all, so
    // naming one would answer it by assuming it.
    const total = (sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    // crosses-tenants: as above.
    const bad = sql
      .prepare(
        `SELECT ${key ? key : "rowid"} AS row FROM ${table}
          WHERE tenant_id IS NULL OR TRIM(tenant_id) = '' LIMIT ${MAX_LISTED + 1}`
      )
      .all() as Array<{ row: string | number }>;
    return {
      name: `tenant/${table}`,
      outcome: bad.length === 0 ? "pass" : "violated",
      examined: total,
      violations: bad.slice(0, MAX_LISTED).map((r) => ({
        table,
        row: `${key ?? "rowid"}=${String(r.row)}`,
        tenant: "(none)",
        detail: "no tenant, so no tenant-bound query can ever see this row",
      })),
    };
  });
}

/** Every populated reference resolves, and resolves without leaving its tenant. */
function checkLinks(sql: DatabaseSync): InvariantResult[] {
  return LINKS.map((link): InvariantResult => {
    const name = `reference/${link.child}.${link.column}`;
    const childCols = columnsOf(sql, link.child);
    const parentCols = columnsOf(sql, link.parent);
    const missing: string[] = [];
    if (childCols.length === 0) missing.push(`no table ${link.child}`);
    else if (!childCols.includes(link.column)) missing.push(`${link.child} has no ${link.column}`);
    else if (!childCols.includes("tenant_id")) missing.push(`${link.child} has no tenant_id`);
    if (parentCols.length === 0) missing.push(`no table ${link.parent}`);
    else if (!parentCols.includes(link.key)) missing.push(`${link.parent} has no ${link.key}`);
    else if (!parentCols.includes("tenant_id")) missing.push(`${link.parent} has no tenant_id`);
    if (missing.length > 0) {
      return { name, outcome: "unevaluated", examined: 0, violations: [], reason: missing.join("; ") };
    }

    const key = rowKey(childCols) ?? "rowid";
    // crosses-tenants: deliberately. The child is matched to its parent
    // within one tenant, and a child that finds no parent there is then
    // looked for across every tenant — because "the parent exists, under
    // somebody else's custody" and "the parent does not exist" are different
    // incidents, and the first cannot be seen from inside one tenant.
    const rows = sql
      .prepare(
        `SELECT c.${key} AS row, c.tenant_id AS tenant, c.${link.column} AS ref,
                EXISTS(SELECT 1 FROM ${link.parent} p WHERE p.${link.key} = c.${link.column}) AS elsewhere
           FROM ${link.child} c
          WHERE c.${link.column} IS NOT NULL AND TRIM(c.${link.column}) != ''
            AND NOT EXISTS (
              SELECT 1 FROM ${link.parent} p
               WHERE p.tenant_id = c.tenant_id AND p.${link.key} = c.${link.column})
          LIMIT ${MAX_LISTED + 1}`
      )
      .all() as Array<{ row: string | number; tenant: string; ref: string; elsewhere: number }>;

    // crosses-tenants: the denominator for the check above, counted the same way.
    const examined = (
      sql
        .prepare(
          `SELECT COUNT(*) AS n FROM ${link.child}
            WHERE ${link.column} IS NOT NULL AND TRIM(${link.column}) != ''`
        )
        .get() as { n: number }
    ).n;

    return {
      name,
      outcome: rows.length === 0 ? "pass" : "violated",
      examined,
      violations: rows.slice(0, MAX_LISTED).map((r) => ({
        table: link.child,
        row: `${key}=${String(r.row)}`,
        tenant: r.tenant,
        detail: r.elsewhere
          ? `${link.column} resolves in ${link.parent} under a different custodian`
          : `${link.column} resolves nowhere in ${link.parent}`,
      })),
    };
  });
}

/**
 * The chains a partial unique index keeps linear, checked anyway.
 *
 * An index enforces from the moment it exists. A database written before one
 * was added, or edited under the engine, can hold exactly what the index
 * would now refuse — and the `CREATE UNIQUE INDEX` that would have caught it
 * runs only once, on the upgrade that added it.
 */
function checkChains(sql: DatabaseSync): InvariantResult[] {
  const out: InvariantResult[] = [];

  const approvals = columnsOf(sql, "score_approvals");
  if (!approvals.includes("supersedes") || !approvals.includes("score_id")) {
    out.push({
      name: "chain/score-approvals-rooted",
      outcome: "unevaluated",
      examined: 0,
      violations: [],
      reason: "score_approvals is missing score_id or supersedes",
    });
  } else {
    // crosses-tenants: every tenant's approval chains at once, grouped by the
    // tenant, which is the only way to inspect all of them from one place.
    const total = (sql.prepare("SELECT COUNT(*) AS n FROM score_approvals").get() as { n: number }).n;
    // crosses-tenants: as above. A score with two roots has two chains and no
    // answer to which approval governed a result that has already gone out.
    const multiRoot = sql
      .prepare(
        `SELECT tenant_id AS tenant, score_id AS score, COUNT(*) AS n
           FROM score_approvals WHERE supersedes IS NULL
          GROUP BY tenant_id, score_id HAVING n > 1 LIMIT ${MAX_LISTED}`
      )
      .all() as Array<{ tenant: string; score: string; n: number }>;
    out.push({
      name: "chain/score-approvals-rooted",
      outcome: multiRoot.length === 0 ? "pass" : "violated",
      examined: total,
      violations: multiRoot.map((r) => ({
        table: "score_approvals",
        row: `score_id=${r.score}`,
        tenant: r.tenant,
        detail: `${r.n} approvals name no predecessor, so the score has ${r.n} chains and no current approval`,
      })),
    });

    // crosses-tenants: as above.
    const forked = sql
      .prepare(
        `SELECT tenant_id AS tenant, score_id AS score, supersedes AS predecessor, COUNT(*) AS n
           FROM score_approvals WHERE supersedes IS NOT NULL
          GROUP BY tenant_id, score_id, supersedes HAVING n > 1 LIMIT ${MAX_LISTED}`
      )
      .all() as Array<{ tenant: string; score: string; predecessor: string; n: number }>;
    out.push({
      name: "chain/score-approvals-linear",
      outcome: forked.length === 0 ? "pass" : "violated",
      examined: total,
      violations: forked.map((r) => ({
        table: "score_approvals",
        row: `supersedes=${r.predecessor}`,
        tenant: r.tenant,
        detail: `${r.n} approvals supersede the same decision, so ${r.score} has two current approvals`,
      })),
    });
  }

  const packages = columnsOf(sql, "conformance_packages");
  if (!packages.includes("activation_state") || !packages.includes("package_id")) {
    out.push({
      name: "chain/conformance-single-active",
      outcome: "unevaluated",
      examined: 0,
      violations: [],
      reason: "conformance_packages is missing package_id or activation_state",
    });
  } else {
    // crosses-tenants: as above.
    const total = (sql.prepare("SELECT COUNT(*) AS n FROM conformance_packages").get() as { n: number }).n;
    // crosses-tenants: as above.
    const active = sql
      .prepare(
        `SELECT tenant_id AS tenant, package_id AS package, COUNT(*) AS n
           FROM conformance_packages WHERE activation_state = 'active'
          GROUP BY tenant_id, package_id HAVING n > 1 LIMIT ${MAX_LISTED}`
      )
      .all() as Array<{ tenant: string; package: string; n: number }>;
    out.push({
      name: "chain/conformance-single-active",
      outcome: active.length === 0 ? "pass" : "violated",
      examined: total,
      violations: active.map((r) => ({
        table: "conformance_packages",
        row: `package_id=${r.package}`,
        tenant: r.tenant,
        detail: `${r.n} versions active at once, so which rules applied to a resource has no answer`,
      })),
    });
  }

  return out;
}

/** Runs every registered check. Read-only, and honest about what it could not run. */
export function inspect(sql: DatabaseSync): Report {
  const results = [...checkTenants(sql), ...checkLinks(sql), ...checkChains(sql)];
  const violated = results.filter((r) => r.outcome === "violated");
  const unevaluated = results.filter((r) => r.outcome === "unevaluated");
  return {
    // An unevaluated check is not a pass. A report that called itself ok
    // while silently skipping half its registry is the failure this whole
    // file is written against.
    ok: violated.length === 0 && unevaluated.length === 0,
    checked: results.length,
    violated,
    unevaluated,
    results,
  };
}

/** The report as an operator reads it. */
export function render(report: Report): string {
  const lines: string[] = [];
  const examined = report.results.reduce((n, r) => n + r.examined, 0);
  lines.push(`${report.checked} invariants, ${examined.toLocaleString("en-CA")} rows examined`);
  if (report.ok) {
    lines.push("every one of them holds.");
    return lines.join("\n");
  }
  for (const r of report.unevaluated) {
    lines.push("", `UNEVALUATED ${r.name}: ${r.reason ?? "no reason recorded"}`);
    lines.push("  This is not a pass. The check did not run.");
  }
  for (const r of report.violated) {
    lines.push("", `VIOLATED ${r.name} (${r.violations.length} of ${r.examined} rows examined)`);
    for (const v of r.violations) lines.push(`  ${v.table} ${v.row} [tenant ${v.tenant}] — ${v.detail}`);
  }
  lines.push("", "Rows are named so they can be found. Treat what is in them as chart content.");
  return lines.join("\n");
}
