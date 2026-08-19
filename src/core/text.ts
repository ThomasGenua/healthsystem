/**
 * Small text helpers for messages people read.
 *
 * An error message is part of the product. "A accepted referral cannot be
 * booked" is the sentence a clerk sees at the moment something has gone wrong,
 * and reading like a template rather than like English costs a little of the
 * confidence they need in what it is telling them.
 */

/**
 * "a" or "an", by the sound of the following word rather than its spelling.
 *
 * The vowel rule alone gets the statuses in this system wrong in both
 * directions: "an unclassified" is right by the rule and "a unit" is not, and
 * "an hour" needs the exception the rule does not have. Short lists rather
 * than a general solution, because the general solution to English
 * pronunciation is a dictionary.
 */
const SOUNDS_CONSONANT = /^(uni|use|user|usual|eu|one-|once)/i;
const SOUNDS_VOWEL = /^(hour|honest|honou?r|heir)/i;

export function article(word: string): "a" | "an" {
  const w = word.trim();
  if (!w) return "a";
  if (SOUNDS_VOWEL.test(w)) return "an";
  if (SOUNDS_CONSONANT.test(w)) return "a";
  return /^[aeiou]/i.test(w) ? "an" : "a";
}

/**
 * The article and the word, which is what every call site actually wants.
 *
 * Trimmed, so a status that arrives empty — from a row written before a column
 * existed, say — produces "a" rather than "a " with a stray space in the
 * middle of the sentence.
 */
export function an(word: string): string {
  return `${article(word)} ${word}`.trim();
}
