/**
 * Orders, and the results that answer them.
 *
 * Section 4 is about two silences, and they are different failures. An order
 * placed and never resulted is the lab never reporting. A result reported and
 * never read is the report arriving and landing on nobody. Both end with a
 * clinician believing the question was answered, and neither produces an
 * error.
 *
 * The one this module is built around is the second, because of a specific way
 * it goes wrong. Laboratories correct results — a specimen is rerun, a
 * transcription is fixed, a preliminary becomes final — and a correction can
 * turn a value nobody needed to act on into one somebody urgently does. If
 * acknowledgement is recorded against the order, or against a result identity
 * that a correction reuses, the corrected value silently inherits the sign-off
 * given to the value it replaced. The chart then shows a potassium of 7.1
 * marked reviewed, and nobody has ever seen it.
 *
 * So results are appended, never updated. A correction is a new row that
 * supersedes an earlier one, and acknowledgement lives on the row. There is no
 * mechanism by which it could carry over, because carrying over would mean
 * writing it onto a row nobody wrote it onto.
 *
 * Two smaller decisions in the same spirit:
 *
 * Unsolicited results are kept. A result from another facility, or against an
 * order placed on paper, has no order here to attach to — and it is a real
 * result about a real patient. Refusing it would lose it, so it is stored and
 * queued for matching.
 *
 * Responsibility is a column, not an inference from who ordered. Residents
 * rotate, locums leave, and a result routed to whoever happened to type the
 * order three weeks ago is a result nobody reads. `handover` moves it, with a
 * reason, and refuses to leave it belonging to nobody.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";

export type OrderCategory = "lab" | "imaging" | "procedure" | "referral" | "other";
export type OrderStatus = "draft" | "placed" | "in-progress" | "completed" | "cancelled";
export type OrderPriority = "routine" | "urgent" | "stat";

/**
 * How abnormal a result is, which is also how quickly it must be read.
 *
 * `critical-low` and `critical-high` are the panic-value range: results a
 * laboratory telephones through because waiting for someone to check a queue
 * is not safe.
 */
export type AbnormalFlag = "normal" | "low" | "high" | "critical-low" | "critical-high" | "abnormal";

export type ResultStatus = "preliminary" | "final" | "corrected" | "cancelled";

/**
 * How long acknowledgement may wait, by how abnormal the value is.
 *
 * Normal results are on the list too. "It was normal" is known after reading
 * it, not before, and the results most often missed are the ones assumed
 * unremarkable. The window is simply longer.
 */
const ACK_WINDOW_HOURS: Record<AbnormalFlag, number> = {
  "critical-low": 1,
  "critical-high": 1,
  abnormal: 24,
  low: 24,
  high: 24,
  normal: 72,
};

/** Ordering for a queue: the most abnormal first, then the oldest. */
const FLAG_RANK: Record<AbnormalFlag, number> = {
  "critical-low": 0,
  "critical-high": 0,
  abnormal: 1,
  high: 1,
  low: 1,
  normal: 2,
};

export interface OrderRow {
  tenant_id: string;
  id: string;
  patient_id: string;
  encounter_id: string | null;
  category: OrderCategory;
  code: string;
  code_system: string | null;
  display: string;
  status: OrderStatus;
  priority: OrderPriority;
  indication: string;
  ordered_by: string;
  ordered_at: string | null;
  responsible_id: string | null;
  expected_by: string | null;
  correlation_id: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface ResultRow {
  tenant_id: string;
  id: string;
  order_id: string | null;
  patient_id: string;
  code: string;
  code_system: string | null;
  display: string;
  value: string;
  unit: string | null;
  reference_range: string | null;
  abnormal_flag: AbnormalFlag;
  result_status: ResultStatus;
  supersedes: string | null;
  observed_at: string | null;
  reported_at: string;
  reported_by: string;
  source_message_id: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  acknowledgement_action: string | null;
  ack_due_by: string | null;
  created_at: string;
}

export interface OrderEvent {
  seq: number;
  order_id: string;
  at: string;
  event: string;
  actor_id: string;
  actor_kind: string;
  from_status: string | null;
  to_status: string | null;
  detail: string | null;
}

export interface Actor {
  actorId: string;
  actorKind: string;
}

function hoursFrom(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * 3_600_000).toISOString();
}

export class OrderStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Records an order. Draft until placed.
   *
   * An indication is required for the same reason a referral needs one: it is
   * what lets whoever performs the test know what is being asked, and what
   * lets anyone afterwards judge whether the test was the right one.
   */
  create(input: {
    patientId: string;
    category: OrderCategory;
    code: string;
    display: string;
    indication: string;
    by: Actor;
    codeSystem?: string;
    encounterId?: string;
    priority?: OrderPriority;
    correlationId?: string;
  }): OrderRow {
    if (!input.indication.trim()) {
      throw new Error("an order needs an indication, or the result cannot be interpreted");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      this.db.sql
        .prepare(
          `INSERT INTO orders
             (tenant_id, id, patient_id, encounter_id, category, code, code_system, display,
              status, priority, indication, ordered_by, correlation_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          this.db.tenantId,
          id,
          input.patientId,
          input.encounterId ?? null,
          input.category,
          input.code,
          input.codeSystem ?? null,
          input.display,
          input.priority ?? "routine",
          input.indication,
          input.by.actorId,
          input.correlationId ?? id,
          now,
          now
        );
      this.event(id, "created", input.by, { toStatus: "draft", detail: input.display });
      return this.get(id)!;
    });
  }

  /**
   * Places the order, naming who reads the result.
   *
   * Responsibility is required here rather than defaulted to the orderer,
   * because the default is wrong exactly when it matters: a resident who
   * ordered a test on their last day of a rotation is not who should receive
   * the result. Making it explicit means somebody chose.
   */
  place(orderId: string, by: Actor & { responsibleId: string; expectedBy?: string }): OrderRow {
    if (!by.responsibleId.trim()) {
      throw new Error("an order needs somebody responsible for reading the result");
    }
    const o = this.require(orderId);
    if (o.status !== "draft") throw new Error(`a ${o.status} order cannot be placed again`);
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db.sql
        .prepare(
          `UPDATE orders SET status = 'placed', ordered_at = ?, responsible_id = ?, expected_by = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ?`
        )
        .run(now, by.responsibleId, by.expectedBy ?? null, now, this.db.tenantId, orderId);
      this.event(orderId, "placed", by, {
        fromStatus: o.status,
        toStatus: "placed",
        detail: `responsible: ${by.responsibleId}`,
      });
      return this.get(orderId)!;
    });
  }

  /**
   * Moves responsibility for reading the result.
   *
   * The rotation problem, and it is a real one: a result that comes back for
   * somebody who left the service goes to an inbox nobody opens. Refuses an
   * empty destination — "unassigned" is how a result stops being anyone's.
   */
  handover(orderId: string, toResponsibleId: string, by: Actor & { reason: string }): OrderRow {
    if (!toResponsibleId.trim()) throw new Error("handing over needs somebody to hand over to");
    if (!by.reason.trim()) throw new Error("handing over a result needs a reason");
    const o = this.require(orderId);
    return this.db.transaction(() => {
      this.db.sql
        .prepare("UPDATE orders SET responsible_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
        .run(toResponsibleId, new Date().toISOString(), this.db.tenantId, orderId);
      this.event(orderId, "handover", by, {
        detail: `${o.responsible_id ?? "(nobody)"} to ${toResponsibleId}: ${by.reason}`,
      });
      return this.get(orderId)!;
    });
  }

  /** The lab picked up the specimen, the department scheduled the scan. */
  start(orderId: string, by: Actor, detail?: string): OrderRow {
    const o = this.require(orderId);
    if (o.status !== "placed") throw new Error(`a ${o.status} order cannot be started`);
    return this.transition(orderId, "in-progress", by, detail);
  }

  cancel(orderId: string, by: Actor & { reason: string }): OrderRow {
    if (!by.reason.trim()) throw new Error("cancelling an order needs a reason");
    const o = this.require(orderId);
    if (o.status === "completed" || o.status === "cancelled") {
      throw new Error(`this order is already ${o.status}`);
    }
    return this.transition(orderId, "cancelled", by, by.reason, true);
  }

  /**
   * Files a result.
   *
   * `orderId` is optional. An unsolicited result — from another facility, or
   * against an order placed on paper — is a real result about a real patient,
   * and refusing it would lose it. It is stored and appears in `unmatched()`
   * until somebody attaches it.
   *
   * The acknowledgement clock starts here and is set by how abnormal the value
   * is, so a panic value and a routine one are not on the same queue.
   */
  report(input: {
    patientId: string;
    code: string;
    display: string;
    value: string;
    reportedBy: string;
    orderId?: string;
    codeSystem?: string;
    unit?: string;
    referenceRange?: string;
    abnormalFlag?: AbnormalFlag;
    resultStatus?: ResultStatus;
    observedAt?: string;
    reportedAt?: string;
    sourceMessageId?: string;
  }): ResultRow {
    if (input.orderId) {
      const o = this.require(input.orderId);
      if (o.patient_id !== input.patientId) {
        // The one mismatch never worth resolving automatically: a result on
        // the wrong chart is the harm this whole module is about.
        throw new Error(`result is for ${input.patientId} but order ${input.orderId} is for ${o.patient_id}`);
      }
    }
    return this.db.transaction(() => this.insertResult(input, null));
  }

  /**
   * Files a correction, superseding an earlier result.
   *
   * The new row arrives unacknowledged, and that is the entire point. A
   * correction can turn a value nobody needed to act on into one somebody
   * urgently does, so a sign-off given to the old value must not follow the
   * new one — the chart would show a critical result marked reviewed by a
   * clinician who never saw it.
   *
   * The superseded row keeps its own acknowledgement, because it is true: that
   * person did read that value. What is false is that anyone has read this
   * one.
   */
  correct(
    resultId: string,
    input: {
      value: string;
      reportedBy: string;
      abnormalFlag?: AbnormalFlag;
      unit?: string;
      referenceRange?: string;
      resultStatus?: ResultStatus;
      observedAt?: string;
      reportedAt?: string;
      sourceMessageId?: string;
    }
  ): ResultRow {
    const prior = this.result(resultId);
    if (!prior) throw new Error(`no result ${resultId}`);
    if (this.supersededBy(resultId)) throw new Error("that result has already been corrected");
    return this.db.transaction(() =>
      this.insertResult(
        {
          patientId: prior.patient_id,
          code: prior.code,
          display: prior.display,
          codeSystem: prior.code_system ?? undefined,
          orderId: prior.order_id ?? undefined,
          referenceRange: input.referenceRange ?? prior.reference_range ?? undefined,
          unit: input.unit ?? prior.unit ?? undefined,
          value: input.value,
          reportedBy: input.reportedBy,
          abnormalFlag: input.abnormalFlag ?? prior.abnormal_flag,
          resultStatus: input.resultStatus ?? "corrected",
          observedAt: input.observedAt ?? prior.observed_at ?? undefined,
          reportedAt: input.reportedAt,
          sourceMessageId: input.sourceMessageId,
        },
        resultId
      )
    );
  }

  /**
   * A clinician says they have read it, and what they did.
   *
   * The action is required for the same reason task completion requires
   * evidence: "acknowledged" alone records that a screen was clicked, and the
   * question a review asks is what happened next. "Patient telephoned, coming
   * in this afternoon" is an answer; a timestamp is not.
   *
   * Refused on a superseded result. Signing off a value that has already been
   * corrected is signing off the wrong number, and letting it through would
   * make the queue look clear while the current value stayed unread.
   */
  acknowledge(resultId: string, by: Actor & { action: string }): ResultRow {
    if (!by.action.trim()) {
      throw new Error("acknowledging a result needs to say what was done about it");
    }
    const r = this.result(resultId);
    if (!r) throw new Error(`no result ${resultId}`);
    if (r.acknowledged_at) throw new Error("this result has already been acknowledged");
    const newer = this.supersededBy(resultId);
    if (newer) {
      throw new Error(`this result was corrected; acknowledge ${newer} instead`);
    }
    return this.db.transaction(() => {
      this.db.sql
        .prepare(
          `UPDATE order_results SET acknowledged_by = ?, acknowledged_at = ?, acknowledgement_action = ?
            WHERE tenant_id = ? AND id = ?`
        )
        .run(by.actorId, new Date().toISOString(), by.action, this.db.tenantId, resultId);
      if (r.order_id) {
        this.event(r.order_id, "result-acknowledged", by, { detail: `${r.display}: ${by.action}` });
      }
      return this.result(resultId)!;
    });
  }

  /**
   * Attaches an unsolicited result to the order it answers.
   *
   * Deliberately an action somebody takes rather than a match on code and
   * date. Two potassiums on one morning are not interchangeable, and a wrong
   * automatic match reads afterwards as a result that was filed correctly.
   */
  match(resultId: string, orderId: string, by: Actor): ResultRow {
    const r = this.result(resultId);
    if (!r) throw new Error(`no result ${resultId}`);
    if (r.order_id) throw new Error(`that result is already filed against order ${r.order_id}`);
    const o = this.require(orderId);
    if (o.patient_id !== r.patient_id) {
      throw new Error(`result is for ${r.patient_id} but order ${orderId} is for ${o.patient_id}`);
    }
    return this.db.transaction(() => {
      this.db.sql
        .prepare("UPDATE order_results SET order_id = ? WHERE tenant_id = ? AND id = ?")
        .run(orderId, this.db.tenantId, resultId);
      this.event(orderId, "result-matched", by, { detail: `${r.display} = ${r.value}${r.unit ? " " + r.unit : ""}` });
      this.completeIfResulted(orderId, by);
      return this.result(resultId)!;
    });
  }

  /**
   * Results nobody has read yet, most abnormal first, then oldest.
   *
   * The load-bearing query, and the reason for everything above it. Only
   * current results: a value that has been corrected is not the one anybody
   * should be acting on, and leaving it here would pad the queue with numbers
   * that are no longer true.
   *
   * Ordered by how abnormal rather than by arrival, because a chronological
   * queue buries the critical potassium under forty normal ones — which is the
   * mechanism by which a result is missed with nobody doing anything wrong.
   */
  unacknowledged(opts: { responsibleId?: string; overdueAsOf?: string; limit?: number } = {}): ResultRow[] {
    const args: unknown[] = [this.db.tenantId, this.db.tenantId];
    let sql = `SELECT r.* FROM order_results r
                WHERE r.tenant_id = ? AND r.acknowledged_at IS NULL
                  AND r.result_status != 'cancelled'
                  AND NOT EXISTS (
                    SELECT 1 FROM order_results n
                     WHERE n.tenant_id = ? AND n.supersedes = r.id
                  )`;
    if (opts.responsibleId) {
      sql += ` AND r.order_id IN (SELECT id FROM orders WHERE tenant_id = ? AND responsible_id = ?)`;
      args.push(this.db.tenantId, opts.responsibleId);
    }
    if (opts.overdueAsOf) {
      sql += " AND r.ack_due_by IS NOT NULL AND r.ack_due_by < ?";
      args.push(opts.overdueAsOf);
    }
    const rows = this.db.sql.prepare(sql).all(...(args as never[])) as unknown as ResultRow[];
    rows.sort(
      (a, b) =>
        FLAG_RANK[a.abnormal_flag] - FLAG_RANK[b.abnormal_flag] || a.reported_at.localeCompare(b.reported_at)
    );
    return typeof opts.limit === "number" ? rows.slice(0, opts.limit) : rows;
  }

  /**
   * Orders placed and never answered.
   *
   * The other silence. A specimen that was never processed and a scan that was
   * never performed produce nothing at all, so nothing arrives to be missed —
   * which makes this the harder of the two to notice.
   */
  awaitingResult(asOf = new Date().toISOString()): OrderRow[] {
    // Whether an order has been answered is decided in exactly one place —
    // completeIfResulted, which runs in the same transaction as every result
    // that lands — and this reads that decision rather than making it a
    // second time. Two definitions of "answered" is how a preliminary result
    // came to count as one: the first version of this query excluded any
    // order with a result of any kind, so a blood culture reporting
    // "gram-positive cocci" at 24 hours and never speciating dropped off the
    // list, which is precisely the wait worth chasing.
    return this.db.sql
      .prepare(
        `SELECT o.* FROM orders o
          WHERE o.tenant_id = ? AND o.status IN ('placed', 'in-progress')
            AND o.expected_by IS NOT NULL AND o.expected_by < ?
          ORDER BY o.expected_by`
      )
      .all(this.db.tenantId, asOf) as unknown as OrderRow[];
  }

  /** Results that arrived with no order to file them against. */
  unmatched(): ResultRow[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM order_results WHERE tenant_id = ? AND order_id IS NULL
          ORDER BY reported_at`
      )
      .all(this.db.tenantId) as unknown as ResultRow[];
  }

  get(orderId: string): OrderRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM orders WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, orderId) as unknown as OrderRow | undefined;
  }

  result(resultId: string): ResultRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM order_results WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, resultId) as unknown as ResultRow | undefined;
  }

  /** Every version of a result, oldest first, corrections included. */
  resultHistory(resultId: string): ResultRow[] {
    const chain: ResultRow[] = [];
    let cursor = this.result(resultId);
    while (cursor) {
      chain.unshift(cursor);
      cursor = cursor.supersedes ? this.result(cursor.supersedes) : undefined;
    }
    let last = chain[chain.length - 1];
    for (;;) {
      const next = last ? this.supersededBy(last.id) : undefined;
      if (!next) break;
      const row = this.result(next)!;
      chain.push(row);
      last = row;
    }
    return chain;
  }

  /** Results filed against an order, in the order they were reported. */
  resultsFor(orderId: string): ResultRow[] {
    return this.db.sql
      .prepare("SELECT * FROM order_results WHERE tenant_id = ? AND order_id = ? ORDER BY reported_at, created_at")
      .all(this.db.tenantId, orderId) as unknown as ResultRow[];
  }

  forPatient(patientId: string): OrderRow[] {
    return this.db.sql
      .prepare("SELECT * FROM orders WHERE tenant_id = ? AND patient_id = ? ORDER BY created_at DESC")
      .all(this.db.tenantId, patientId) as unknown as OrderRow[];
  }

  history(orderId: string): OrderEvent[] {
    return this.db.sql
      .prepare("SELECT * FROM order_events WHERE tenant_id = ? AND order_id = ? ORDER BY seq")
      .all(this.db.tenantId, orderId) as unknown as OrderEvent[];
  }

  private insertResult(
    input: {
      patientId: string;
      code: string;
      display: string;
      value: string;
      reportedBy: string;
      orderId?: string;
      codeSystem?: string;
      unit?: string;
      referenceRange?: string;
      abnormalFlag?: AbnormalFlag;
      resultStatus?: ResultStatus;
      observedAt?: string;
      reportedAt?: string;
      sourceMessageId?: string;
    },
    supersedes: string | null
  ): ResultRow {
    const id = randomUUID();
    const now = new Date().toISOString();
    const reportedAt = input.reportedAt ?? now;
    const flag = input.abnormalFlag ?? "normal";
    const status = input.resultStatus ?? "final";
    // A preliminary result is not yet something to sign off, so it starts no
    // clock; the final one that follows it does.
    const ackDueBy = status === "preliminary" || status === "cancelled" ? null : hoursFrom(reportedAt, ACK_WINDOW_HOURS[flag]);

    this.db.sql
      .prepare(
        `INSERT INTO order_results
           (tenant_id, id, order_id, patient_id, code, code_system, display, value, unit,
            reference_range, abnormal_flag, result_status, supersedes, observed_at, reported_at,
            reported_by, source_message_id, ack_due_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        id,
        input.orderId ?? null,
        input.patientId,
        input.code,
        input.codeSystem ?? null,
        input.display,
        input.value,
        input.unit ?? null,
        input.referenceRange ?? null,
        flag,
        status,
        supersedes,
        input.observedAt ?? null,
        reportedAt,
        input.reportedBy,
        input.sourceMessageId ?? null,
        ackDueBy,
        now
      );

    if (input.orderId) {
      const who = { actorId: input.reportedBy, actorKind: "device" };
      this.event(input.orderId, supersedes ? "result-corrected" : "result-reported", who, {
        detail: `${input.display} = ${input.value}${input.unit ? " " + input.unit : ""}${
          flag === "normal" ? "" : ` (${flag})`
        }`,
      });
      this.completeIfResulted(input.orderId, who);
    }
    return this.result(id)!;
  }

  /**
   * An order with a final result is answered.
   *
   * Completing the order does not close the result: the two are tracked apart
   * precisely so that "the lab reported" and "somebody read it" cannot be
   * mistaken for each other. A preliminary result leaves the order open, since
   * the question is not answered yet.
   */
  private completeIfResulted(orderId: string, by: Actor): void {
    const o = this.get(orderId);
    if (!o || o.status === "completed" || o.status === "cancelled") return;
    const final = this.resultsFor(orderId).some((r) => r.result_status === "final" || r.result_status === "corrected");
    if (!final) return;
    const now = new Date().toISOString();
    this.db.sql
      .prepare("UPDATE orders SET status = 'completed', updated_at = ?, closed_at = ? WHERE tenant_id = ? AND id = ?")
      .run(now, now, this.db.tenantId, orderId);
    this.event(orderId, "completed", by, { fromStatus: o.status, toStatus: "completed" });
  }

  /** The id of the result superseding this one, if there is one. */
  private supersededBy(resultId: string): string | undefined {
    const row = this.db.sql
      .prepare("SELECT id FROM order_results WHERE tenant_id = ? AND supersedes = ?")
      .get(this.db.tenantId, resultId) as { id: string } | undefined;
    return row?.id;
  }

  private transition(orderId: string, to: OrderStatus, by: Actor, detail?: string, closing = false): OrderRow {
    const from = this.require(orderId).status;
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      this.db.sql
        .prepare("UPDATE orders SET status = ?, updated_at = ?, closed_at = ? WHERE tenant_id = ? AND id = ?")
        .run(to, now, closing ? now : null, this.db.tenantId, orderId);
      this.event(orderId, to, by, { fromStatus: from, toStatus: to, ...(detail ? { detail } : {}) });
      return this.get(orderId)!;
    });
  }

  private event(
    orderId: string,
    event: string,
    by: Actor,
    extra: { fromStatus?: string; toStatus?: string; detail?: string }
  ): void {
    this.db.sql
      .prepare(
        `INSERT INTO order_events (tenant_id, order_id, at, event, actor_id, actor_kind, from_status, to_status, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        orderId,
        new Date().toISOString(),
        event,
        by.actorId,
        by.actorKind,
        extra.fromStatus ?? null,
        extra.toStatus ?? null,
        extra.detail ?? null
      );
  }

  private require(orderId: string): OrderRow {
    const o = this.get(orderId);
    if (!o) throw new Error(`no order ${orderId}`);
    return o;
  }
}
