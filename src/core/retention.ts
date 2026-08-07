/**
 * Retention.
 *
 * The message log keeps every raw HL7 message ever received, which is both a
 * disk problem and a privacy one. Data minimisation is not optional for a
 * custodian: holding a patient's admission message for eight years because
 * nothing deletes it is a liability, not a feature.
 *
 * Two controls, and the difference matters:
 *
 *   Redaction replaces every stored copy of the payload with a tombstone. The
 *   message, its lineage, its pipeline steps and its deliveries all remain as
 *   rows, and the hash chain still verifies in full, because the chain commits
 *   to a digest taken at ingest rather than to the payload. You keep the record
 *   that a message flowed, from where, through which steps, and whether it was
 *   delivered; you lose the clinical content wherever it was held. This is
 *   almost always the right control.
 *
 *   Purging deletes the rows. It reclaims disk and it destroys the record that
 *   anything happened, so the chain can only be verified from the purge point
 *   forward. Offered because operators sometimes genuinely need it, and
 *   deliberately not the default.
 *
 * Neither touches the FHIR facade. That store holds the current clinical
 * record a consumer is reading, not a log of traffic; deciding how long a
 * territorial EHR keeps a Patient resource is a clinical governance question,
 * not something an interface engine should quietly answer.
 */
import type { Db } from "../db.ts";
import type { AuditStore } from "../audit/store.ts";

export interface RetentionPolicy {
  /** Redact message payloads older than this many days. */
  redactAfterDays?: number;
  /** Delete messages older than this many days. Off unless set. */
  purgeAfterDays?: number;
  /** How often the sweep runs. Defaults to hourly. */
  sweepIntervalMs?: number;
}

export interface RetentionResult {
  redactedMessages: number;
  redactedDeliveries: number;
  redactedSteps: number;
  purgedMessages: number;
  purgedChannels: string[];
  redactCutoff?: string;
  purgeCutoff?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** SQLite compares datetimes as text, so cutoffs use its own format. */
function cutoff(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().replace("T", " ").slice(0, 19);
}

export class RetentionRunner {
  private db: Db;
  private audit: AuditStore | undefined;
  private policy: RetentionPolicy;
  private timer: NodeJS.Timeout | null = null;

  constructor(db: Db, policy: RetentionPolicy = {}, audit?: AuditStore) {
    this.db = db;
    this.policy = policy;
    this.audit = audit;
  }

  get enabled(): boolean {
    return this.policy.redactAfterDays !== undefined || this.policy.purgeAfterDays !== undefined;
  }

  describe(): RetentionPolicy & { redactable: number; purgeable: number; oldest?: string } {
    const r = this.policy.redactAfterDays !== undefined ? cutoff(this.policy.redactAfterDays) : undefined;
    const p = this.policy.purgeAfterDays !== undefined ? cutoff(this.policy.purgeAfterDays) : undefined;
    return { ...this.policy, ...this.db.retentionCounts(r, p) };
  }

  /**
   * Applies the policy once.
   *
   * Purge runs before redaction: a row about to be deleted need not be
   * rewritten first, and doing it the other way round would report a
   * redaction that immediately ceased to exist.
   */
  run(): RetentionResult {
    const result: RetentionResult = {
      redactedMessages: 0,
      redactedDeliveries: 0,
      redactedSteps: 0,
      purgedMessages: 0,
      purgedChannels: [],
    };

    if (this.policy.purgeAfterDays !== undefined) {
      const c = cutoff(this.policy.purgeAfterDays);
      const purged = this.db.purgeBefore(c);
      result.purgedMessages = purged.messages;
      result.purgedChannels = purged.channels;
      result.purgeCutoff = c;
    }

    if (this.policy.redactAfterDays !== undefined) {
      const c = cutoff(this.policy.redactAfterDays);
      const redacted = this.db.redactBefore(c);
      result.redactedMessages = redacted.messages;
      result.redactedDeliveries = redacted.deliveries;
      result.redactedSteps = redacted.steps;
      result.redactCutoff = c;
    }

    // Destroying patient data is itself an event worth being able to account
    // for, so a run that changed anything is recorded on the audit trail.
    if (this.audit && (result.redactedMessages || result.purgedMessages)) {
      this.audit.record({
        action: "D",
        principalId: "retention",
        principalKind: "system",
        method: "SWEEP",
        path: "/retention",
        resourceType: "Message",
        count: result.redactedMessages + result.purgedMessages,
        detail:
          `redacted ${result.redactedMessages} message(s), ${result.redactedSteps} pipeline step(s) and ` +
          `${result.redactedDeliveries} delivery payload(s); purged ${result.purgedMessages} message(s)`,
      });
    }

    return result;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    const every = this.policy.sweepIntervalMs ?? 60 * 60 * 1000;
    // Sweep at boot so a long-stopped instance does not sit on expired data
    // until the first interval elapses.
    this.run();
    this.timer = setInterval(() => {
      try {
        this.run();
      } catch (err) {
        console.error(`retention sweep: ${err instanceof Error ? err.message : err}`);
      }
    }, every);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
