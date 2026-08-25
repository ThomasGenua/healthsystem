/**
 * Linking charts that are one person — reversibly, which merging never is.
 *
 * `PatientIndex.duplicates()` finds candidates and its docstring declines to
 * act: "Merging is how a chart acquires someone else's allergies, and there is
 * no honest way to unmerge afterwards." That objection is correct and this
 * module does not overturn it. What it rules out is destruction, not
 * assertion: a **link** says two charts are the same person, carries who
 * asserted it, when, and on what evidence, and the chart assembles across the
 * members without either being rewritten. Every row stays attributed to the
 * chart it was written on, so an unlink restores the prior view exactly —
 * which is the property the docstring says merging can never have.
 *
 * ## A link is a clinical decision
 *
 * It is never inferred. `duplicates()` stays advisory — a shared health
 * number is close to conclusive, a shared name and birth date is a prompt,
 * and twins, spouses, and a father and son with one name between them are why
 * the distance between "candidate" and "linked" is a person reading the
 * evidence and signing their name to it. The hazard when that person is
 * wrong is exact: one patient's allergies rendered on another's chart. The
 * controls are reversibility, and the assembled chart saying on its face
 * that it is assembled — never a silent combination.
 *
 * ## Events, not state
 *
 * A link is a row and an unlink is another row. The history of who asserted
 * what, and who withdrew it and why, outlives every decision — the same
 * position the rest of the record takes, for the same reason.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";
import { Refusal } from "../core/refusal.ts";

export interface LinkEvent {
  seq: number;
  tenant_id: string;
  link_id: string;
  event: "linked" | "unlinked";
  patient_a: string;
  patient_b: string;
  detail: string;
  actor_id: string;
  actor_kind: string;
  at: string;
}

/** An assertion currently in force. */
export interface ActiveLink {
  linkId: string;
  patientA: string;
  patientB: string;
  evidence: string;
  linkedBy: string;
  linkedAt: string;
}

export interface Actor {
  actorId: string;
  actorKind: string;
}

export class PatientLinks {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Asserts that two charts are one person.
   *
   * The evidence is required and has to be worth reading later: "same person"
   * restates the decision, it does not defend it. A pair already linked —
   * directly or through a chain — is refused rather than doubled, so the
   * history stays one assertion per relationship.
   */
  link(a: string, b: string, by: Actor & { evidence: string }): ActiveLink {
    if (a === b) throw new Refusal("a chart cannot be linked to itself", 409);
    const evidence = by.evidence.trim();
    if (evidence.length < 12) {
      throw new Refusal(
        "linking two charts needs evidence somebody can weigh afterwards — say what was checked, not that they match",
        400
      );
    }
    return this.db.transaction(() => {
      if (this.membersOf(a).includes(b)) {
        throw new Refusal(`${a} and ${b} are already linked`, 409);
      }
      const linkId = randomUUID();
      this.insert(linkId, "linked", a, b, evidence, by);
      const active = this.active().find((l) => l.linkId === linkId)!;
      return active;
    });
  }

  /**
   * Withdraws an assertion, with a reason that is kept.
   *
   * Nothing is deleted and nothing was ever moved, so the prior view returns
   * exactly: each chart's rows were always its own. The reason matters as
   * much as the evidence did — "linked in error, they are father and son" is
   * the sentence the next reviewer of `duplicates()` needs to see.
   */
  unlink(linkId: string, by: Actor & { reason: string }): LinkEvent {
    const reason = by.reason.trim();
    if (reason.length < 8) {
      throw new Refusal("unlinking needs a reason somebody can read later", 400);
    }
    return this.db.transaction(() => {
      const current = this.active().find((l) => l.linkId === linkId);
      if (!current) {
        const ever = this.db.sql
          .prepare("SELECT 1 FROM patient_link_events WHERE tenant_id = ? AND link_id = ?")
          .get(this.db.tenantId, linkId);
        throw new Refusal(ever ? `link ${linkId} is already withdrawn` : `no link ${linkId}`, ever ? 409 : 404);
      }
      this.insert(linkId, "unlinked", current.patientA, current.patientB, reason, by);
      return this.db.sql
        .prepare("SELECT * FROM patient_link_events WHERE tenant_id = ? AND link_id = ? ORDER BY seq DESC LIMIT 1")
        .get(this.db.tenantId, linkId) as unknown as LinkEvent;
    });
  }

  /**
   * Every chart this one is currently asserted to share a person with,
   * including itself, sorted — the closure over active links, because if A is
   * B and B is C, a clinician reading A's chart is owed C's allergies too.
   */
  membersOf(patientId: string): string[] {
    const links = this.active();
    const seen = new Set<string>([patientId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const l of links) {
        if (seen.has(l.patientA) && !seen.has(l.patientB)) {
          seen.add(l.patientB);
          grew = true;
        }
        if (seen.has(l.patientB) && !seen.has(l.patientA)) {
          seen.add(l.patientA);
          grew = true;
        }
      }
    }
    return [...seen].sort();
  }

  /** The assertions currently in force that touch any member of this chart. */
  linksFor(patientId: string): ActiveLink[] {
    const members = new Set(this.membersOf(patientId));
    return this.active().filter((l) => members.has(l.patientA) || members.has(l.patientB));
  }

  /**
   * The two charts a link id is or was about — withdrawn links included,
   * because a failed attempt to touch a link still belongs on both charts'
   * trails. An id that never named a link answers [], there being nobody to
   * write it on.
   */
  patientsOf(linkId: string): string[] {
    const row = this.db.sql
      .prepare("SELECT patient_a, patient_b FROM patient_link_events WHERE tenant_id = ? AND link_id = ? LIMIT 1")
      .get(this.db.tenantId, linkId) as { patient_a: string; patient_b: string } | undefined;
    return row ? [row.patient_a, row.patient_b] : [];
  }

  /** Every link and unlink that ever touched this chart, oldest first. */
  historyFor(patientId: string): LinkEvent[] {
    return this.db.sql
      .prepare(
        `SELECT * FROM patient_link_events
          WHERE tenant_id = ? AND (patient_a = ? OR patient_b = ?) ORDER BY seq`
      )
      .all(this.db.tenantId, patientId, patientId) as unknown as LinkEvent[];
  }

  // ---- internals -----------------------------------------------------------

  /** Assertions whose latest event is still "linked". */
  private active(): ActiveLink[] {
    const rows = this.db.sql
      .prepare("SELECT * FROM patient_link_events WHERE tenant_id = ? ORDER BY seq")
      .all(this.db.tenantId) as unknown as LinkEvent[];
    const byLink = new Map<string, LinkEvent>();
    for (const r of rows) byLink.set(r.link_id, r);
    return [...byLink.values()]
      .filter((r) => r.event === "linked")
      .map((r) => ({
        linkId: r.link_id,
        patientA: r.patient_a,
        patientB: r.patient_b,
        evidence: r.detail,
        linkedBy: r.actor_id,
        linkedAt: r.at,
      }));
  }

  private insert(linkId: string, event: "linked" | "unlinked", a: string, b: string, detail: string, by: Actor): void {
    this.db.sql
      .prepare(
        `INSERT INTO patient_link_events
           (tenant_id, link_id, event, patient_a, patient_b, detail, actor_id, actor_kind, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(this.db.tenantId, linkId, event, a, b, detail, by.actorId, by.actorKind, new Date().toISOString());
  }
}
