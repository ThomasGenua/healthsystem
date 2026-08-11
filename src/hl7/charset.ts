/**
 * Character sets on HL7 v2 frames.
 *
 * MLLP carries bytes. HL7 v2 declares which character set those bytes are in,
 * in MSH-18 — a field inside the message, which is the awkward part: the
 * charset cannot be known until the message is read, and the message cannot be
 * read until the charset is known. It resolves because MSH itself is
 * ASCII-safe by construction (the delimiters, the field names and every value
 * in Table 0211 are ASCII), so a byte-preserving first pass is enough to find
 * the declaration and then decode the whole frame properly.
 *
 * Getting this wrong is not a display problem. Decoding ISO-8859-1 as UTF-8
 * turns every accented byte into U+FFFD, and that substitution is lossy and
 * irreversible: `Bédard` becomes `B<?>dard` and the original byte is gone.
 * The sender is acknowledged AA, the chain commits to the corrupted bytes and
 * verifies clean forever, and nobody finds out. Names carrying accents and
 * syllabics are not an edge case in the north — they are most of the register.
 *
 * So decoding here is strict. A frame that is not valid in its declared
 * character set is refused, and the sender is told, rather than being stored
 * with substitutions that look like data.
 */

/**
 * HL7 Table 0211 values, mapped to WHATWG encoding labels.
 *
 * Only the ones a Canadian deployment realistically meets. The rest of the
 * table (JIS, GB, KS) would be dead weight here, and an unrecognised value is
 * refused loudly rather than guessed at.
 */
const TABLE_0211: Record<string, string> = {
  ASCII: "utf-8", // 7-bit, and every byte of it decodes identically as UTF-8
  "8859/1": "iso-8859-1",
  "8859/2": "iso-8859-2",
  "8859/15": "iso-8859-15",
  "UNICODE UTF-8": "utf-8",
  "UNICODE": "utf-8",
};

/** The default when a sender declares nothing. */
export const DEFAULT_CHARSET = "UNICODE UTF-8";

export class CharsetError extends Error {}

/**
 * Reads MSH-18 without decoding the rest.
 *
 * latin1 maps every byte to the codepoint of the same value, so it round-trips
 * bytes exactly — which makes it the right lens for finding an ASCII field in
 * a frame whose real encoding is not yet known. Nothing outside MSH is touched
 * with it.
 */
export function declaredCharset(bytes: Buffer): string | undefined {
  // MSH-18 is the 18th field; nothing beyond the MSH segment is needed, and a
  // segment terminator is CR.
  const crAt = bytes.indexOf(0x0d);
  const msh = bytes.subarray(0, crAt === -1 ? bytes.length : crAt).toString("latin1");
  if (!msh.startsWith("MSH")) return undefined;

  // MSH-1 is the field separator itself, and MSH-2 the encoding characters,
  // so the split lands MSH-n at index n-1 with the usual off-by-one already
  // absorbed by "MSH" occupying slot 0.
  const sep = msh[3];
  if (!sep) return undefined;
  const value = msh.split(sep)[17]?.trim();
  return value ? value : undefined;
}

/** Whether a Table 0211 value is one this engine can decode. */
export function isSupportedCharset(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TABLE_0211, name.toUpperCase().trim());
}

/**
 * Decodes a frame, honouring what it declares.
 *
 * `configured` is the channel's setting, used when the sender declares
 * nothing — which is most senders. A declaration in the message wins over it,
 * since that is the sender stating a fact about the bytes it just sent.
 */
export function decodeFrame(
  bytes: Buffer,
  configured: string = DEFAULT_CHARSET
): { text: string; charset: string } {
  const declared = declaredCharset(bytes);
  const charset = (declared ?? configured).toUpperCase().trim();
  const label = TABLE_0211[charset];
  if (!label) {
    throw new CharsetError(
      `unsupported character set ${JSON.stringify(declared ?? configured)}` +
        `${declared ? " declared in MSH-18" : " configured for this channel"}; ` +
        `supported: ${Object.keys(TABLE_0211).join(", ")}`
    );
  }

  try {
    // fatal, so invalid input throws instead of being substituted. The whole
    // point: a message that cannot be read must be refused, not stored with
    // replacement characters that a clinician would read as the patient's
    // actual name.
    return { text: new TextDecoder(label, { fatal: true }).decode(bytes), charset };
  } catch {
    throw new CharsetError(
      `frame is not valid ${charset}` +
        (declared
          ? " although MSH-18 declares it"
          : `; the channel is configured for ${configured} and the sender declared nothing`)
    );
  }
}

/**
 * Encodes a payload for the wire in the given character set.
 *
 * The reverse of the above and just as load-bearing: replying to a sender that
 * speaks ISO-8859-1 in UTF-8 corrupts the patient name in the acknowledgement,
 * and answering with characters the set cannot represent is worse than
 * answering without them.
 */
export function encodeFrame(text: string, charset: string = DEFAULT_CHARSET): Buffer {
  const label = TABLE_0211[charset.toUpperCase().trim()];
  if (!label) throw new CharsetError(`unsupported character set ${JSON.stringify(charset)}`);
  if (label === "utf-8") return Buffer.from(text, "utf8");

  // Everything else is single-byte, and Node encodes none of them: only
  // `latin1` exists as an encoder, and it truncates each codepoint to its low
  // byte rather than failing — so ᐃᓄᒃᑎᑐᑦ would become plausible-looking
  // garbage. Round-tripping through the real decoder is what catches that, and
  // a character that does not survive is reported rather than dropped. A
  // mangled acknowledgement is a mangled clinical record as far as the
  // sender's reconciliation log is concerned.
  //
  // The consequence, stated rather than hidden: outbound frames are fully
  // supported in UTF-8 and ISO-8859-1. For 8859/2 and 8859/15 the byte values
  // above 0x7F do not line up with latin1's, so those encode ASCII and refuse
  // the rest. They still decode inbound in full, which is the direction that
  // carries patient data.
  const out = Buffer.from(text, "latin1");
  if (new TextDecoder(label, { fatal: false }).decode(out) !== text) {
    throw new CharsetError(`payload cannot be represented in ${charset}`);
  }
  return out;
}
