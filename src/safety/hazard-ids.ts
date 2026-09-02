/**
 * Comparing one revision of the hazard log against another.
 *
 * `test/clinical-safety.test.ts` already checks the log it can see: no
 * duplicate identifier, no gap, every citation resolving. All three look at
 * one tree, and the failure that costs a hazard needs two.
 *
 * A hazard identifier is allocated by reading the last row and adding one.
 * That is a shared counter with nobody holding it. Two branches taken from a
 * log ending at H-162 both allocate H-163, and each is correct on its own —
 * no duplicate, no gap, nothing to see. The collision exists only in the
 * relationship between them, so nothing that reads a single tree can find it.
 *
 * What happens at the merge is the part worth preventing. If the two rows
 * land on adjacent lines git reports a conflict and offers them as
 * alternatives, which is a menu with no right answer on it:
 *
 *   - keep both, and the log has two rows sharing an identifier, so a control
 *     traced to "H-163" is traced to whichever a reader finds first;
 *   - keep one, and a hazard is **gone** from the safety case — its analysis,
 *     its control and its evidence — with nothing anywhere to say it was
 *     ever written.
 *
 * The first is caught after the fact by the duplicate-identifier test. The
 * second is caught by nothing at all, which is why this exists: the log
 * still reads as a clean, gapless, duplicate-free sequence, and the missing
 * row is missing the way an unwritten row is missing.
 *
 * And if the two land far enough apart to merge without a conflict, the
 * duplicate arrives silently and is only found later, on a branch nobody is
 * looking at any more. (That has happened here twice.)
 *
 * So: the identity of a hazard is its **name**, and a name may not change
 * under a fixed identifier. Its cause, control and evidence are expected to
 * be refined — that is what a live safety case does, and none of it is
 * checked here. Renaming the hazard means it is a different hazard, and a
 * different hazard needs its own number.
 */

/** One row of the log, reduced to the two columns identity depends on. */
export interface HazardRow {
  id: string;
  /** The Hazard column: the short statement of what can go wrong. */
  name: string;
}

export type Collision =
  | { kind: "renamed"; id: string; base: string; head: string }
  | { kind: "removed"; id: string; base: string };

const ROW = /^\|\s*(H-\d+)\s*\|\s*([^|]*?)\s*\|/;

/** Reads the hazard rows out of a `docs/CLINICAL-SAFETY.md`. */
export function parseHazards(markdown: string): HazardRow[] {
  const rows: HazardRow[] = [];
  for (const line of markdown.split("\n")) {
    const m = ROW.exec(line);
    if (m) rows.push({ id: m[1], name: m[2] });
  }
  return rows;
}

/**
 * The number a new hazard should take, given a log.
 *
 * Padded to the log's own width, which is two digits from H-01 and grows
 * with the count. Advice that reads `H-5` where every other row reads `H-05`
 * is advice a contributor has to correct before following, and half of them
 * will paste it as given.
 */
export function nextId(rows: HazardRow[]): string {
  const highest = rows.reduce((n, r) => Math.max(n, Number(r.id.slice(2))), 0);
  const width = rows.reduce((w, r) => Math.max(w, r.id.length - 2), 2);
  return `H-${String(highest + 1).padStart(width, "0")}`;
}

/** The three revisions the comparison needs. */
export interface Revisions {
  /** Where this branch and the base last agreed. */
  mergeBase: HazardRow[];
  /** The base branch as it stands now, which is what this will merge into. */
  baseTip: HazardRow[];
  /** This revision. */
  head: HazardRow[];
}

/**
 * What this revision does to identifiers that are not its to spend.
 *
 * The two questions need different references, which is the whole subtlety
 * and the reason a first version of this reported six hazards as deleted
 * that were merely newer than the branch:
 *
 *   - **Renamed** is asked against the base **tip**. If the tip says H-163 is
 *     one hazard and this says it is another, they collide — whenever the tip
 *     acquired it. That is precisely the case where both branches allocated
 *     the same number from the same log, and it is invisible from either side
 *     alone.
 *
 *   - **Removed** is asked against the **merge base**. An identifier the tip
 *     gained after this branch was taken is *expected* to be absent here;
 *     that is what being behind means, not a deletion. Only one that was
 *     present when the branch was taken, and is gone now, was dropped by
 *     somebody.
 *
 * Adding rows is the ordinary case and is never reported.
 */
export function compareHazards(revs: Revisions): Collision[] {
  const here = new Map(revs.head.map((r) => [r.id, r.name]));
  const out: Collision[] = [];

  for (const row of revs.baseTip) {
    const mine = here.get(row.id);
    if (mine !== undefined && mine !== row.name) {
      out.push({ kind: "renamed", id: row.id, base: row.name, head: mine });
    }
  }
  for (const row of revs.mergeBase) {
    if (!here.has(row.id)) {
      // A hazard does not stop being a hazard because the code changed. If
      // it no longer applies it is retired in place, with the reason, so the
      // safety case still accounts for it.
      out.push({ kind: "removed", id: row.id, base: row.name });
    }
  }
  return out;
}

/**
 * The message a contributor gets, written to be actionable on its own.
 *
 * The number it suggests clears **both** logs. Suggesting one free only here
 * would recommend an identifier the base branch has already spent, which is
 * the mistake being reported.
 */
export function explain(collisions: Collision[], revs: Revisions): string {
  const lines = [`${collisions.length} hazard identifier(s) do not mean here what they mean on the base branch.`, ""];
  const both = [...revs.baseTip, ...revs.head];
  const width = nextId(both).length - 2;
  let next = Number(nextId(both).slice(2));
  const suggest = (): string => `H-${String(next++).padStart(width, "0")}`;
  for (const c of collisions) {
    if (c.kind === "removed") {
      lines.push(
        `  ${c.id} is on the base branch and is not here.`,
        `      base: ${c.base}`,
        `      A hazard is retired in place, with the reason, not deleted: the safety`,
        `      case has to keep accounting for it. If this came from resolving a merge`,
        `      conflict, the other side's row was dropped — put it back.`,
        ""
      );
    } else {
      lines.push(
        `  ${c.id} names a different hazard here than on the base branch.`,
        `      base: ${c.base}`,
        `      here: ${c.head}`,
        `      Both branches allocated this number from the same log. Renumber this`,
        `      one to ${suggest()} and update anything citing it.`,
        ""
      );
    }
  }
  lines.push("A hazard's cause, control and evidence are expected to be refined; its name is its identity.");
  return lines.join("\n");
}
