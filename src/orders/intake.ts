/**
 * Filing a laboratory result against the order it answers.
 *
 * This is the half of section 4 that a FHIR mapping does not do. Mapping an
 * ORU onto an Observation produces a copy of a value; it does not close an
 * order, it does not start an acknowledgement clock, and it does not know that
 * tonight's repeat transmission is the same potassium it filed this morning.
 *
 * Four decisions carry this module, and each is a way a laboratory interface
 * quietly goes wrong.
 *
 * ## A result whose patient cannot be identified is held, not guessed
 *
 * The worst outcome available here is a result on the wrong chart, and the
 * ordinary route to it is a helpful fallback: match on name when the health
 * number misses, match on the only patient with that surname, attach to the
 * most recent order. All of those are wrong in the case that matters. So the
 * patient is resolved by identifier or not at all, an ambiguous match is a
 * refusal, and the result waits in `heldForIdentity()` where a human can see
 * it. A held result is visible work; a misfiled one is invisible harm.
 *
 * ## A resend is not a new result
 *
 * Laboratories retransmit: on reconnect, on a nightly repeat, after a queue
 * drains. Filing each copy again would fill the unacknowledged queue with
 * duplicates of a value somebody already read, and a queue that cannot be
 * emptied is a queue clinicians stop reading. Identity comes from the
 * laboratory's accession number, the analyte and the sub-id, so an identical
 * resend is recorded as `unchanged` and writes nothing.
 *
 * ## A correction is not a duplicate
 *
 * The same key with a different value is the case the whole orders module was
 * built around: it supersedes, and the new row arrives unacknowledged even if
 * the old one was signed off. That behaviour is `OrderStore.correct()`; this
 * module's job is only to tell the two apart, which is exactly what the key
 * is for.
 *
 * ## A stale preliminary must not overwrite a final
 *
 * Out-of-order delivery is real, and a preliminary arriving after the final it
 * preceded would otherwise reopen a closed question and un-answer an order.
 * It is ignored, and recorded as ignored, rather than either applied or
 * dropped silently.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { refuse } from "../core/refusal.ts";
import type { PatientIndex } from "../clinical/patients.ts";
import { OrderStore, type ResultRow } from "./store.ts";
import { GENERIC_LAB_PROFILE, isCriticalFlag, parseOru, resultKey, type LabProfile, type ParsedObservation, type ParsedOru } from "./hl7.ts";

export type IntakeOutcome =
  /** A result the chart did not have. */
  | "filed"
  /** Byte-identical to what is already filed. Nothing written. */
  | "unchanged"
  /** A new value superseding an earlier one. */
  | "corrected"
  /** The laboratory withdrew the result. */
  | "cancelled"
  /** A preliminary that arrived after the final. Recorded, not applied. */
  | "ignored-stale"
  /** The patient could not be identified. Waiting for a person. */
  | "held";

export interface IntakeResult {
  outcome: IntakeOutcome;
  /** Absent when held or ignored. */
  result?: ResultRow;
  /** The order this was filed against, when one was found. */
  orderId?: string;
  detail: string;
}

export interface IntakeReport {
  messageControlId: string;
  patientId: string | null;
  profileId: string;
  results: IntakeResult[];
  /** True when any observation carried a time with no zone anywhere. */
  timezoneAssumed: boolean;
}

export interface HeldResultRow {
  tenant_id: string;
  id: string;
  profile_id: string;
  source_message_id: string | null;
  message_control_id: string;
  sending_facility: string;
  identifiers: string;
  patient_name: string;
  patient_birth_date: string;
  placer_order_number: string;
  filler_order_number: string;
  reason: string;
  payload: string;
  received_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_patient_id: string | null;
  created_at: string;
}

/** What a reconciliation asks of a laboratory feed. */
export interface Reconciliation {
  since: string | null;
  profileId: string | null;
  filed: number;
  corrected: number;
  cancelled: number;
  /** Results filed with no order to answer, still awaiting a person. */
  unmatchedOrders: number;
  /** Results whose patient could not be identified, still awaiting a person. */
  heldForIdentity: number;
  /** Filed results nobody has read yet. */
  unacknowledged: number;
  /** Of those, the ones already past their acknowledgement window. */
  overdue: number;
  /** Critical values not yet read. The number that matters most. */
  criticalUnacknowledged: number;
  /** Results whose observation time carried no timezone. */
  timezoneAssumed: number;
  /** Distinct accession numbers seen, so a lab's own count can be compared. */
  accessions: number;
  caveats: string[];
}

export class LabIntake {
  private db: Db;
  private orders: OrderStore;
  private index: PatientIndex;

  constructor(db: Db, orders: OrderStore, index: PatientIndex) {
    this.db = db;
    this.orders = orders;
    this.index = index;
  }

  /**
   * Files every observation in one ORU message.
   *
   * One transaction for the whole message. A message half filed is worse than
   * one refused: the delivery retries, and the second attempt would file the
   * remaining observations while the first half deduplicated, leaving a
   * partial panel that looks complete.
   */
  ingest(
    raw: string,
    opts: { profile?: LabProfile; sourceMessageId?: string } = {}
  ): IntakeReport {
    const profile = opts.profile ?? GENERIC_LAB_PROFILE;
    const parsed = parseOru(raw, profile);
    return this.db.transaction(() => this.fileParsed(parsed, raw, profile, opts.sourceMessageId));
  }

  private fileParsed(
    parsed: ParsedOru,
    raw: string,
    profile: LabProfile,
    sourceMessageId?: string
  ): IntakeReport {
    const timezoneAssumed = parsed.observations.some((o) => o.timezoneAssumed);
    const match = this.resolvePatient(parsed, profile);

    if (!match.patientId) {
      const id = this.hold(parsed, raw, profile, match.reason, sourceMessageId);
      return {
        messageControlId: parsed.messageControlId,
        patientId: null,
        profileId: profile.id,
        timezoneAssumed,
        results: [{ outcome: "held", detail: `${match.reason}; held as ${id} for a person to resolve` }],
      };
    }

    const patientId = match.patientId;
    const orderId = this.matchOrder(parsed, patientId);
    const results = parsed.observations.map((obs) =>
      this.fileObservation(parsed, obs, patientId, orderId, sourceMessageId)
    );

    // Recorded on the order rather than inferred later: a reconciliation that
    // has to guess which accession answered which requisition cannot be run
    // against the laboratory's own numbers.
    if (orderId && parsed.fillerOrderNumber) {
      this.db.sql
        .prepare(
          `UPDATE orders SET filler_order_number = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ? AND (filler_order_number IS NULL OR filler_order_number = '')`
        )
        .run(parsed.fillerOrderNumber, new Date().toISOString(), this.db.tenantId, orderId);
    }

    return {
      messageControlId: parsed.messageControlId,
      patientId,
      profileId: profile.id,
      timezoneAssumed,
      results,
    };
  }

  private fileObservation(
    parsed: ParsedOru,
    obs: ParsedObservation,
    patientId: string,
    orderId: string | undefined,
    sourceMessageId?: string
  ): IntakeResult {
    const key = resultKey(parsed, obs);
    const current = this.currentByKey(key);
    const reportedAt = parsed.reportedAt ?? undefined;
    const notes = obs.notes.length ? ` — ${obs.notes.join(" ")}` : "";
    const display = obs.display + (obs.subId ? ` (${obs.subId})` : "");

    if (!current) {
      const result = this.orders.report({
        patientId,
        code: obs.code,
        display,
        value: obs.value + notes,
        reportedBy: `${parsed.sendingApplication || "lab"}:${parsed.profileId}`,
        ...(orderId ? { orderId } : {}),
        ...(obs.codeSystem ? { codeSystem: obs.codeSystem } : {}),
        ...(obs.unit ? { unit: obs.unit } : {}),
        ...(obs.referenceRange ? { referenceRange: obs.referenceRange } : {}),
        abnormalFlag: obs.abnormalFlag,
        resultStatus: obs.resultStatus,
        ...(obs.observedAt ? { observedAt: obs.observedAt } : {}),
        ...(reportedAt ? { reportedAt } : {}),
        ...(sourceMessageId ? { sourceMessageId } : {}),
      });
      this.stamp(result.id, key, parsed, obs);
      return {
        outcome: "filed",
        result: this.orders.result(result.id)!,
        ...(orderId ? { orderId } : {}),
        detail: `${display} = ${obs.value}${obs.unit ? " " + obs.unit : ""} (${obs.resultStatus}${
          obs.abnormalFlag === "normal" ? "" : ", " + obs.abnormalFlag
        })`,
      };
    }

    // A preliminary that arrives after the final it preceded. Out-of-order
    // delivery is ordinary; reopening an answered order because of it is not.
    const settled = current.result_status === "final" || current.result_status === "corrected";
    if (obs.resultStatus === "preliminary" && settled) {
      return {
        outcome: "ignored-stale",
        result: current,
        ...(current.order_id ? { orderId: current.order_id } : {}),
        detail: `a preliminary ${display} arrived after the ${current.result_status} value; kept the ${current.result_status}`,
      };
    }

    const sameValue = current.value === obs.value + notes;
    const sameUnit = (current.unit ?? null) === (obs.unit ?? null);
    const sameFlag = current.abnormal_flag === obs.abnormalFlag;
    const sameStatus = current.result_status === obs.resultStatus;
    if (sameValue && sameUnit && sameFlag && sameStatus) {
      // The retransmission case. Nothing is written, deliberately: a second
      // row would need acknowledging a second time.
      return {
        outcome: "unchanged",
        result: current,
        ...(current.order_id ? { orderId: current.order_id } : {}),
        detail: `${display} already filed with this value and status`,
      };
    }

    const corrected = this.orders.correct(current.id, {
      value: obs.value + notes,
      reportedBy: `${parsed.sendingApplication || "lab"}:${parsed.profileId}`,
      abnormalFlag: obs.abnormalFlag,
      ...(obs.unit ? { unit: obs.unit } : {}),
      ...(obs.referenceRange ? { referenceRange: obs.referenceRange } : {}),
      resultStatus: obs.resultStatus,
      ...(obs.observedAt ? { observedAt: obs.observedAt } : {}),
      ...(reportedAt ? { reportedAt } : {}),
      ...(sourceMessageId ? { sourceMessageId } : {}),
    });
    this.stamp(corrected.id, key, parsed, obs);
    return {
      outcome: obs.resultStatus === "cancelled" ? "cancelled" : "corrected",
      result: this.orders.result(corrected.id)!,
      ...(corrected.order_id ? { orderId: corrected.order_id } : {}),
      detail:
        obs.resultStatus === "cancelled"
          ? `${display} withdrawn by the laboratory`
          : `${display} ${current.value} → ${obs.value}${obs.unit ? " " + obs.unit : ""}`,
    };
  }

  /**
   * The patient this result is about, by identifier only.
   *
   * Name and birth date are read from the message and stored on a held row so
   * a person resolving it can see who the laboratory thought it was — but they
   * are never matched on. Two people share a name and a birthday more often
   * than a health system expects, and the failure is silent.
   */
  private resolvePatient(parsed: ParsedOru, profile: LabProfile): { patientId?: string; reason: string } {
    const candidates = profile.patientAssigningAuthority
      ? parsed.patient.identifiers.filter((i) => i.assigningAuthority === profile.patientAssigningAuthority)
      : parsed.patient.identifiers;

    if (candidates.length === 0) {
      return {
        reason: profile.patientAssigningAuthority
          ? `no PID-3 identifier from assigning authority ${profile.patientAssigningAuthority}`
          : "the message carries no patient identifier",
      };
    }

    const found = new Set<string>();
    for (const candidate of candidates) {
      const query = profile.patientIdentifierSystem
        ? `${profile.patientIdentifierSystem}|${candidate.value}`
        : candidate.value;
      for (const hit of this.index.search({ identifier: query, limit: 5 })) {
        found.add(hit.patientId);
      }
    }

    if (found.size === 1) return { patientId: [...found][0], reason: "matched on identifier" };
    if (found.size > 1) {
      // Two charts answering one health number is exactly what
      // PatientIndex.duplicates() surfaces and refuses to merge. Picking one
      // here would make that refusal pointless.
      return { reason: `identifier matches ${found.size} charts; a person must say which` };
    }
    return { reason: `no chart carries ${candidates.map((c) => c.value).join(", ")}` };
  }

  /**
   * The order this result answers, by the requisition number we issued.
   *
   * Never by code and date. Two potassiums on one morning are not
   * interchangeable, and a wrong automatic match reads afterwards as a result
   * filed correctly — which is why `OrderStore.match()` exists as an action a
   * person takes. A result with no match is filed unattached and appears in
   * `unmatched()`.
   */
  private matchOrder(parsed: ParsedOru, patientId: string): string | undefined {
    if (!parsed.placerOrderNumber) return undefined;
    const row = this.db.sql
      .prepare(
        `SELECT id FROM orders
          WHERE tenant_id = ? AND patient_id = ? AND (id = ? OR correlation_id = ?)
          ORDER BY created_at DESC LIMIT 1`
      )
      .get(this.db.tenantId, patientId, parsed.placerOrderNumber, parsed.placerOrderNumber) as
      | { id: string }
      | undefined;
    return row?.id;
  }

  private currentByKey(key: string): ResultRow | undefined {
    return this.db.sql
      .prepare(
        `SELECT r.* FROM order_results r
          WHERE r.tenant_id = ? AND r.result_key = ?
            AND NOT EXISTS (
              SELECT 1 FROM order_results n WHERE n.tenant_id = r.tenant_id AND n.supersedes = r.id
            )
          ORDER BY r.created_at DESC LIMIT 1`
      )
      .get(this.db.tenantId, key) as unknown as ResultRow | undefined;
  }

  private stamp(resultId: string, key: string, parsed: ParsedOru, obs: ParsedObservation): void {
    this.db.sql
      .prepare(
        `UPDATE order_results
            SET result_key = ?, filler_order_number = ?, source_system = ?,
                timezone_assumed = ?, raw_status = ?, raw_flag = ?
          WHERE tenant_id = ? AND id = ?`
      )
      .run(
        key,
        parsed.fillerOrderNumber || null,
        parsed.profileId,
        obs.timezoneAssumed ? 1 : 0,
        obs.rawStatus,
        obs.rawFlag,
        this.db.tenantId,
        resultId
      );
  }

  private hold(
    parsed: ParsedOru,
    raw: string,
    profile: LabProfile,
    reason: string,
    sourceMessageId?: string
  ): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO lab_identity_holds
           (tenant_id, id, profile_id, source_message_id, message_control_id, sending_facility,
            identifiers, patient_name, patient_birth_date, placer_order_number, filler_order_number,
            reason, payload, received_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId,
        id,
        profile.id,
        sourceMessageId ?? null,
        parsed.messageControlId,
        parsed.sendingFacility,
        JSON.stringify(parsed.patient.identifiers),
        `${parsed.patient.family}, ${parsed.patient.given}`.trim(),
        parsed.patient.birthDate,
        parsed.placerOrderNumber,
        parsed.fillerOrderNumber,
        reason,
        raw,
        now,
        now
      );
    return id;
  }

  /**
   * Results waiting on somebody to say whose they are.
   *
   * The queue that makes refusing to guess safe. A held result is a result
   * that exists, is visible, and is owed to a person — which is the whole
   * difference between this and dropping it.
   */
  heldForIdentity(): HeldResultRow[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM lab_identity_holds
          WHERE tenant_id = ? AND resolved_at IS NULL
          ORDER BY received_at`
      )
      .all(this.db.tenantId) as unknown as HeldResultRow[];
  }

  hold_(id: string): HeldResultRow | undefined {
    return this.db.sql
      .prepare("SELECT * FROM lab_identity_holds WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as HeldResultRow | undefined;
  }

  /**
   * A person names the chart, and the held message is filed as if it had
   * arrived identified.
   *
   * It goes back through the same path, so deduplication, correction and order
   * matching all apply. A second route into the record would be a second set
   * of rules about what a resend means.
   */
  resolveIdentity(
    holdId: string,
    patientId: string,
    by: { actorId: string }
  ): IntakeReport {
    const row = this.hold_(holdId);
    if (!row) refuse(`no held laboratory result ${holdId}`);
    if (row.resolved_at) refuse("that held result has already been resolved");
    if (!this.index.get(patientId)) {
      refuse(`no chart ${patientId}; a held result must be filed against a chart that exists`);
    }
    return this.db.transaction(() => {
      const parsed = parseOru(row.payload, { ...GENERIC_LAB_PROFILE, id: row.profile_id });
      const orderId = this.matchOrder(parsed, patientId);
      const results = parsed.observations.map((obs) =>
        this.fileObservation(parsed, obs, patientId, orderId, row.source_message_id ?? undefined)
      );
      this.db.sql
        .prepare(
          `UPDATE lab_identity_holds
              SET resolved_at = ?, resolved_by = ?, resolved_patient_id = ?
            WHERE tenant_id = ? AND id = ?`
        )
        .run(new Date().toISOString(), by.actorId, patientId, this.db.tenantId, holdId);
      return {
        messageControlId: parsed.messageControlId,
        patientId,
        profileId: row.profile_id,
        timezoneAssumed: parsed.observations.some((o) => o.timezoneAssumed),
        results,
      };
    });
  }

  /**
   * What a laboratory sent and what became of it.
   *
   * The report an operator takes to the laboratory when the two counts
   * disagree. It is deliberately not a health check: every number here is a
   * count of rows somebody can go and look at, and the caveats say what the
   * numbers cannot tell you — because an interface that reports itself healthy
   * while results sit unread is the failure this whole module exists to catch.
   */
  reconcile(opts: { since?: string; profileId?: string } = {}): Reconciliation {
    const args: unknown[] = [this.db.tenantId];
    let filter = "";
    if (opts.since) {
      filter += " AND r.reported_at >= ?";
      args.push(opts.since);
    }
    if (opts.profileId) {
      filter += " AND r.source_system = ?";
      args.push(opts.profileId);
    } else {
      filter += " AND r.source_system IS NOT NULL";
    }

    const row = this.db.sql
      .prepare(
        `SELECT
           COUNT(*) AS filed,
           SUM(CASE WHEN r.result_status = 'corrected' THEN 1 ELSE 0 END) AS corrected,
           SUM(CASE WHEN r.result_status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
           SUM(CASE WHEN r.timezone_assumed = 1 THEN 1 ELSE 0 END) AS tz,
           COUNT(DISTINCT r.filler_order_number) AS accessions,
           SUM(CASE WHEN r.order_id IS NULL THEN 1 ELSE 0 END) AS unmatched
         FROM order_results r
        WHERE r.tenant_id = ?${filter}`
      )
      .get(...(args as never[])) as {
      filed: number;
      corrected: number | null;
      cancelled: number | null;
      tz: number | null;
      accessions: number;
      unmatched: number | null;
    };

    const outstanding = this.orders
      .unacknowledged()
      .filter((r) => r.source_system !== null && (!opts.profileId || r.source_system === opts.profileId))
      .filter((r) => !opts.since || r.reported_at >= opts.since);
    const now = new Date().toISOString();

    const caveats = [
      "counts are of results this system filed; only the laboratory can say what it sent",
      "an unacknowledged result is not a failed interface — it is work owed to a clinician",
    ];
    if ((row.tz ?? 0) > 0) {
      caveats.push(
        `${row.tz} result(s) carried an observation time with no timezone; set timezoneOffset on the lab profile to remove the ambiguity`
      );
    }
    const held = this.heldForIdentity().length;
    if (held > 0) {
      caveats.push(`${held} result(s) could not be matched to a chart and are waiting for a person`);
    }

    return {
      since: opts.since ?? null,
      profileId: opts.profileId ?? null,
      filed: row.filed,
      corrected: row.corrected ?? 0,
      cancelled: row.cancelled ?? 0,
      unmatchedOrders: row.unmatched ?? 0,
      heldForIdentity: held,
      unacknowledged: outstanding.length,
      overdue: outstanding.filter((r) => r.ack_due_by !== null && r.ack_due_by < now).length,
      criticalUnacknowledged: outstanding.filter((r) => isCriticalFlag(r.raw_flag ?? "") || r.abnormal_flag.startsWith("critical")).length,
      timezoneAssumed: row.tz ?? 0,
      accessions: row.accessions,
      caveats,
    };
  }
}
