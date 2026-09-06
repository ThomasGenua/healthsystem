/**
 * The logistics around a travelling-clinic visit, owned by somebody, and not
 * marked confirmed on hope.
 *
 * `Clinics` (clinics.ts) plans the visit itself: the slots, the waitlist, the
 * seat. None of that is the trip. A patient three hundred kilometres from the
 * nearest road, an interpreter for a language the visiting clinician does not
 * speak, a wheelchair-accessible vehicle for the last leg — these are
 * arranged separately, often with somebody outside the clinic entirely, and
 * "the appointment exists" says nothing about whether any of them happened.
 *
 * ## Ownership and confirmation are the two facts that matter
 *
 * Everything else here exists to keep those two facts honest. An arrangement
 * always has one of six kinds, taken verbatim from what was asked for:
 * transport, accommodation, interpreter, escort, equipment, accessibility.
 * `assign()` says who is chasing it. `confirm()` and `requestExternally()`
 * are the only two ways to reach `confirmed`, and both require evidence —
 * a clerk's own written account of how they know, or an external system's
 * own answer, never the mere fact that a request was sent. Sending a request
 * is not the same as it being granted, which is the same lesson item 59
 * already had to learn about a notification handed to a gateway.
 *
 * ## A changed visit does not silently strand its arrangements
 *
 * `Clinics.cancelVisit()` and `Clinics.rescheduleVisit()` know nothing about
 * this module and are not changed by it — every real caller of either is the
 * API layer, so `reviewAfterVisitChange()` is called from there, immediately
 * after, rather than through a hook retrofitted into a module this one did
 * not touch. It does not guess which arrangements are now wrong: a transport
 * booked for the old date might still be usable, or might not, and that is a
 * judgement this module does not have the facts to make. What it does is
 * raise one task per live arrangement on the changed visit, so the question
 * is asked by a person rather than never asked at all.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { refuse } from "../core/refusal.ts";
import type { TaskStore, TaskRow } from "../work/tasks.ts";

export interface Actor {
  actorId: string;
  actorKind: string;
}

export const ARRANGEMENT_KINDS = ["transport", "accommodation", "interpreter", "escort", "equipment", "accessibility"] as const;
export type ArrangementKind = (typeof ARRANGEMENT_KINDS)[number];

export type ArrangementStatus = "needed" | "requested" | "confirmed" | "cancelled";

export interface ArrangementRow {
  tenant_id: string;
  id: string;
  visit_id: string;
  patient_id: string | null;
  kind: ArrangementKind;
  detail: string;
  status: ArrangementStatus;
  owner_id: string | null;
  external_reference: string | null;
  confirmation_evidence: string | null;
  confirmed_at: string | null;
  confirmed_by: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancelled_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** The one thing this needs from Clinics — see discharge.ts for the same loose coupling. */
export interface ClinicsSource {
  visit(id: string): { id: string; status: string } | undefined;
}

export interface ExternalCoordinationResult {
  /** What the external system says identifies this booking. Never empty — an empty reference is not evidence. */
  reference: string;
  /** Whether the external system itself says this is confirmed, not whether a request merely went out. */
  confirmed: boolean;
  note?: string;
}

/** A real integration — a charter service's API, an interpreter agency's booking system — implements this. */
export interface ExternalCoordinator {
  request(input: {
    kind: ArrangementKind;
    detail: string;
    visitId: string;
    patientId?: string;
  }): Promise<ExternalCoordinationResult> | ExternalCoordinationResult;
}

/**
 * A marker that makes the synthetic coordinator's answer controllable in a
 * test or demo, the same convention `EICAR_TEST_STRING` uses in intake.ts:
 * the fake external system confirms immediately only when asked to, and
 * otherwise behaves like a real one that has to be asked again later —
 * because a synthetic integration that always confirmed on the first try
 * would make "requires evidence" untestable.
 */
export const SYNTHETIC_CONFIRM_MARKER = "SYNTHETIC-CONFIRM-NOW";

/**
 * A coordinator that reaches nothing real. For development and demonstration
 * only — see SyntheticScanner in intake.ts for the same shape of stand-in.
 */
export class SyntheticExternalCoordinator implements ExternalCoordinator {
  request(input: { kind: ArrangementKind; detail: string }): ExternalCoordinationResult {
    const confirmed = input.detail.includes(SYNTHETIC_CONFIRM_MARKER);
    const reference = `synthetic-${randomUUID()}`;
    return confirmed
      ? { reference, confirmed: true, note: `synthetic ${input.kind} coordinator confirmed immediately (demonstration only)` }
      : { reference, confirmed: false, note: `synthetic ${input.kind} coordinator has logged the request; nobody has answered yet (demonstration only)` };
  }
}

function parse(row: unknown): ArrangementRow {
  return row as ArrangementRow;
}

export class Arrangements {
  private db: Db;
  private clinics: ClinicsSource;
  private tasks: TaskStore;
  private external?: ExternalCoordinator;

  constructor(db: Db, clinics: ClinicsSource, tasks: TaskStore, external?: ExternalCoordinator) {
    this.db = db;
    this.clinics = clinics;
    this.tasks = tasks;
    this.external = external;
  }

  /** Raises a need. Nothing is arranged yet — `needed` is the honest starting state. */
  request(input: { visitId: string; patientId?: string; kind: ArrangementKind; detail: string; by: Actor }): ArrangementRow {
    if (!(ARRANGEMENT_KINDS as readonly string[]).includes(input.kind)) {
      refuse(`unknown arrangement kind ${input.kind}; expected one of ${ARRANGEMENT_KINDS.join(", ")}`);
    }
    if (!input.detail.trim()) refuse("an arrangement needs a written detail: what is needed, and for whom");
    const visit = this.clinics.visit(input.visitId);
    if (!visit) refuse(`no visit ${input.visitId}`, 404);
    if (visit.status === "cancelled") refuse(`visit ${input.visitId} is cancelled; there is nothing left to arrange for it`);

    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO arrangements
           (tenant_id, id, visit_id, patient_id, kind, detail, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'needed', ?, ?, ?)`
      )
      .run(this.db.tenantId, id, input.visitId, input.patientId ?? null, input.kind, input.detail.trim(), input.by.actorId, now, now);
    return this.get(id)!;
  }

  assign(id: string, ownerId: string, by: Actor): ArrangementRow {
    const row = this.require(id);
    if (row.status === "cancelled") refuse("a cancelled arrangement cannot be assigned");
    if (!ownerId.trim()) refuse("an arrangement needs somebody to own it");
    void by;
    this.db.sql
      .prepare("UPDATE arrangements SET owner_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
      .run(ownerId, new Date().toISOString(), this.db.tenantId, id);
    return this.get(id)!;
  }

  /**
   * The manual-coordination path: a person writes down how they know this is
   * arranged. Works from `needed` or `requested` — the second covers an
   * external request that came back unconfirmed and was then confirmed some
   * other way, a phone call following up on a booking the system itself
   * cannot yet see resolved.
   */
  confirm(id: string, input: { evidence: string; by: Actor }): ArrangementRow {
    const row = this.require(id);
    if (row.status === "cancelled") refuse("a cancelled arrangement cannot be confirmed");
    if (row.status === "confirmed") refuse("this arrangement is already confirmed");
    if (!input.evidence.trim()) {
      refuse("confirming an arrangement needs written evidence of how it was confirmed; a status is not evidence");
    }
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `UPDATE arrangements
            SET status = 'confirmed', confirmed_at = ?, confirmed_by = ?, confirmation_evidence = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`
      )
      .run(now, input.by.actorId, input.evidence.trim(), now, this.db.tenantId, id);
    return this.get(id)!;
  }

  /**
   * Asks a configured external system to do the arranging. Its own answer is
   * the evidence — `confirmed: true` becomes a confirmation with the
   * returned reference recorded verbatim; anything else becomes `requested`,
   * because a request handed to another party is not yet the thing it asked
   * for, the same distinction PatientContacts' delivery states already draw.
   */
  async requestExternally(id: string, by: Actor): Promise<ArrangementRow> {
    if (!this.external) refuse("no external coordinator is configured for this deployment; use confirm() with manual evidence instead");
    const row = this.require(id);
    if (row.status === "cancelled") refuse("a cancelled arrangement cannot be requested");
    if (row.status === "confirmed") refuse("this arrangement is already confirmed");

    const result = await this.external!.request({
      kind: row.kind,
      detail: row.detail,
      visitId: row.visit_id,
      ...(row.patient_id ? { patientId: row.patient_id } : {}),
    });
    if (!result.reference.trim()) {
      refuse("an external coordinator returned no reference; an empty reference is not evidence of anything");
    }
    const now = new Date().toISOString();
    void by;
    if (result.confirmed) {
      this.db.sql
        .prepare(
          `UPDATE arrangements
              SET status = 'confirmed', confirmed_at = ?, confirmed_by = ?, confirmation_evidence = ?, external_reference = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ?`
        )
        .run(now, by.actorId, result.note ?? `confirmed by external system, reference ${result.reference}`, result.reference, now, this.db.tenantId, id);
    } else {
      this.db.sql
        .prepare(`UPDATE arrangements SET status = 'requested', external_reference = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`)
        .run(result.reference, now, this.db.tenantId, id);
    }
    return this.get(id)!;
  }

  cancel(id: string, input: { reason: string; by: Actor }): ArrangementRow {
    const row = this.require(id);
    if (row.status === "cancelled") refuse("this arrangement is already cancelled");
    if (!input.reason.trim()) refuse("cancelling an arrangement needs a written reason");
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `UPDATE arrangements SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancelled_reason = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`
      )
      .run(now, input.by.actorId, input.reason.trim(), now, this.db.tenantId, id);
    return this.get(id)!;
  }

  get(id: string): ArrangementRow | undefined {
    const row = this.db.sql.prepare("SELECT * FROM arrangements WHERE tenant_id = ? AND id = ?").get(this.db.tenantId, id);
    return row ? parse(row) : undefined;
  }

  forVisit(visitId: string): ArrangementRow[] {
    return (
      this.db.sql.prepare("SELECT * FROM arrangements WHERE tenant_id = ? AND visit_id = ? ORDER BY created_at").all(this.db.tenantId, visitId) as unknown[]
    ).map(parse);
  }

  forPatient(patientId: string): ArrangementRow[] {
    return (
      this.db.sql
        .prepare("SELECT * FROM arrangements WHERE tenant_id = ? AND patient_id = ? ORDER BY created_at")
        .all(this.db.tenantId, patientId) as unknown[]
    ).map(parse);
  }

  /** Every live arrangement not yet confirmed, across the tenant — the logistics board's queue. */
  unconfirmed(): ArrangementRow[] {
    return (
      this.db.sql
        .prepare("SELECT * FROM arrangements WHERE tenant_id = ? AND status IN ('needed', 'requested') ORDER BY created_at")
        .all(this.db.tenantId) as unknown[]
    ).map(parse);
  }

  /**
   * A visit changed. Every live arrangement on it gets one reassignment task
   * — not an automatic status change, because whether an already-confirmed
   * booking survives a one-day move or a cancelled visit is a question this
   * module cannot answer from here, and answering it silently either way
   * would be inventing a fact nobody actually checked.
   */
  reviewAfterVisitChange(visitId: string, input: { reason: string; by: Actor }): TaskRow[] {
    if (!input.reason.trim()) refuse("reviewing arrangements after a visit change needs a reason; it will be on every task raised");
    const live = this.forVisit(visitId).filter((a) => a.status !== "cancelled");
    const raised: TaskRow[] = [];
    for (const a of live) {
      raised.push(
        this.tasks.create({
          kind: "arrangement",
          title: `Re-check ${a.kind} arrangement for visit ${visitId}: ${input.reason}`,
          by: input.by,
          priority: "urgent",
          correlationId: a.id,
          ...(a.patient_id ? { patientId: a.patient_id } : {}),
        })
      );
    }
    return raised;
  }

  private require(id: string): ArrangementRow {
    const row = this.get(id);
    if (!row) refuse(`no arrangement ${id}`, 404);
    return row;
  }
}
