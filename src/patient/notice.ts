/**
 * Sending the notice a patient is owed when somebody breaks glass on them.
 *
 * Until this existed the guarantee was "an operator is shown a list of patients
 * they owe a phone call". That is honest and it is thin: the argument for a
 * lockbox being survivable in a clinical setting rests on the override being
 * loud, and a queue that depends on somebody working through it every day is
 * loud only as long as somebody does.
 *
 * ## Why this publishes a message rather than sending anything
 *
 * Portage does not know how to reach a patient and should not learn. The
 * patient index holds a name, a birth date and a set of identifiers — nothing
 * to reach anybody by — so any address this module produced would be one it had
 * invented. For a notice whose entire content is "somebody read your medical
 * record", sending it to a wrong number is a worse outcome than not sending it,
 * and it is the failure mode that would be discovered by the person who
 * received it.
 *
 * So the notice becomes a message on a channel the deployment configures, and
 * the deployment's destinations carry it to whatever already knows how to reach
 * patients — a portal, a letter run, a notifications service. That buys the
 * whole delivery machinery for free and on purpose: ordered, durable, retried
 * with backoff, and a dead letter when it cannot be delivered, which is the
 * same treatment every other clinical message gets. A notification that fails
 * silently would be the same defect as the queue nobody drains, one layer down.
 *
 * ## What is in it, and what is deliberately not
 *
 * The fact, not the record. Who broke glass, when, until when, and the reason
 * they gave — a patient reading this is entitled to know all four, and the
 * reason in the clinician's own words is the part that lets them judge it.
 *
 * There is no clinical content, because a disclosure notice that leaks the
 * chart while announcing that the chart was read would be self-defeating. The
 * override id is carried so the patient can ask about a specific event and an
 * operator can find it.
 */
import type { Db } from "../db.ts";
import type { BreakGlassNotice, NoticeDispatcher } from "./consent.ts";

/** The message body a destination receives. */
export interface NoticePayload {
  type: "break-glass-notice";
  overrideId: string;
  patientId: string;
  declaredAt: string;
  expiresAt: string;
  accessedBy: { id: string; kind: string };
  reason: string;
  directiveId: string | null;
  /** Plain wording a channel can pass through unchanged. */
  summary: string;
}

/**
 * Publishes notices onto a channel, which must exist.
 *
 * The channel is checked at construction rather than at the first override.
 * Discovering that the notification channel was misspelled at the moment
 * somebody breaks glass, during an emergency, is the worst possible time to
 * find out — and the failure would be recorded on the row and easily missed.
 */
export class ChannelNoticeDispatcher implements NoticeDispatcher {
  private db: Db;
  private channelId: string;

  constructor(db: Db, channelId: string) {
    this.db = db;
    this.channelId = channelId;
  }

  dispatch(notice: BreakGlassNotice): string {
    // Re-checked per dispatch, not cached: a channel can be removed while the
    // engine runs, and a notice published to a channel that no longer exists
    // would sit in `deliveries` with no destination to go to — enqueued,
    // counted as sent, and delivered nowhere.
    if (!this.db.getChannel(this.channelId)) {
      throw new Error(`no channel '${this.channelId}' to publish the break-glass notice to`);
    }
    const payload: NoticePayload = {
      type: "break-glass-notice",
      overrideId: notice.overrideId,
      patientId: notice.patientId,
      declaredAt: notice.declaredAt,
      expiresAt: notice.expiresAt,
      accessedBy: { id: notice.subjectId, kind: notice.subjectKind },
      reason: notice.reason,
      directiveId: notice.directiveId,
      summary:
        `Your health record was accessed on ${notice.declaredAt} under an emergency override ` +
        `by ${notice.subjectId}. The reason recorded was: ${notice.reason}. ` +
        `The override expires ${notice.expiresAt}. Reference ${notice.overrideId}.`,
    };
    const message = this.db.insertMessage(
      this.channelId,
      "break-glass",
      "application/json",
      JSON.stringify(payload),
      // On the message rather than only in the body, so an operator can find
      // every notice for one patient without parsing payloads.
      { patientId: notice.patientId, overrideId: notice.overrideId }
    );
    return message.id;
  }
}
