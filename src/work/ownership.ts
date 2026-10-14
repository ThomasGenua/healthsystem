/**
 * Every column in this schema that names a person, and what routes it.
 *
 * The handoff record decides whose list a piece of work is on today; the
 * owner column on the row records who it started with. A query that filters
 * a worklist by the column without consulting the record shows work to
 * somebody who handed it away, and hides it from whoever accepted it.
 *
 * That has happened twice. `TaskStore.inbox` was the first, and fixing it
 * left `OrderStore.unacknowledged` doing the same thing one layer down: a
 * clinician who transferred their patients and went on leave kept every
 * outstanding result, including the critical ones, and the colleague who had
 * accepted accountability saw none of them.
 *
 * Both were wired by hand, and nothing would have failed if the second had
 * not been — which is the actual defect, because the third one has not been
 * written yet. So the registry below is the decision, and
 * `test/ownership-routing.test.ts` is what makes it a decision rather than a
 * comment:
 *
 *   - a column in this schema that is not listed here fails the test, so a
 *     new one cannot arrive unnoticed;
 *   - a listed `subjectKind` must actually be consulted in the source, so a
 *     claim to route is checked rather than believed;
 *   - an entry excused by `reason` must not be used to filter a worklist,
 *     so the excuse expires by itself the moment it stops being true.
 *
 * The last one is the point. Every exclusion here rests on the same fact —
 * the column records who was assigned and nothing reads it to build somebody's
 * list — and a reason that would quietly stop being true is not a reason.
 */

export interface OwnerColumn {
  table: string;
  column: string;
  /**
   * The `subject_kind` a handoff uses for this work, when it routes.
   * Exactly one of this and `reason` is set.
   */
  subjectKind?: string;
  /** Why this column decides nobody's worklist, when it does not route. */
  reason?: string;
}

export const OWNER_COLUMNS: OwnerColumn[] = [
  {
    table: "tasks",
    column: "owner_id",
    subjectKind: "task",
  },
  {
    table: "orders",
    column: "responsible_id",
    subjectKind: "order",
  },
  {
    table: "discharges",
    column: "accountable_id",
    subjectKind: "discharge",
  },
  {
    table: "arrangements",
    column: "owner_id",
    reason:
      "names the person organising a travelling clinic visit, and is read back on the arrangement itself. " +
      "Nothing assembles a list of arrangements by owner, so no list can show the wrong one.",
  },
  {
    table: "outreach_items",
    column: "assigned_to",
    reason:
      "records who a campaign item was given to. Outreach is worked from the campaign's own queues — due, " +
      "contacted, declined — and never from one person's name, so a departure leaves nothing stranded on a list.",
  },
  {
    table: "patient_threads",
    column: "owner_id",
    subjectKind: "thread",
  },
  {
    table: "result_release",
    column: "held_by",
    reason:
      "records who placed a hold on releasing a result to a patient — an act somebody performed at a moment, " +
      "like the author on an audit entry. Handing over the work does not make somebody else have decided it.",
  },
];
