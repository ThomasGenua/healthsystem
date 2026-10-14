/**
 * Character sets on the wire.
 *
 * An engine that decodes every frame as UTF-8 corrupts every message that is
 * not UTF-8, silently and permanently. `Bédard` arriving as ISO-8859-1 — which
 * is what most older HL7 v2 interfaces emit — became `B<U+FFFD>dard`, the
 * substitution is irreversible, the sender was acknowledged AA, and the hash
 * chain committed to the corrupted bytes and verified clean forever. Nobody
 * would have found out.
 *
 * That is the same class as acknowledging a message that was never stored:
 * the system reports success while destroying clinical data. It is worse in
 * one respect, because the corrupted record still looks like a record.
 *
 * It is also not an edge case where this runs. Yellowknife, Fort Smith and
 * Iqaluit generate French names, Dene names and Inuktitut syllabics as a
 * matter of course.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/core/engine.ts";
import { mllpSend, frame, deframe } from "../src/hl7/mllp.ts";
import { CharsetError, decodeFrame, declaredCharset, encodeFrame } from "../src/hl7/charset.ts";
import { parseHl7, getHl7 } from "../src/hl7/parser.ts";
import type { ChannelConfig } from "../src/types.ts";

/** An admission carrying names that only survive a correct decode. */
function adt(charsetField: string, encoding: BufferEncoding): Buffer {
  return Buffer.from(
    [
      `MSH|^~\\&|MEDITECH|STANTON|PORTAGE|GNWT|20260805120000||ADT^A01^ADT_A01|C1|P|2.5.1||||||${charsetField}`,
      "PID|1||NT445566^^^NWT^JHN||Bédard^Renée^Thérèse||19750612|F",
      "PV1|1|I",
    ].join("\r") + "\r",
    encoding
  );
}

function channel(charset?: string): ChannelConfig {
  return {
    id: "cs",
    name: "charset",
    source: { type: "mllp", port: 0, ...(charset ? { charset } : {}) },
    destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
  };
}

async function boot(cfg: ChannelConfig) {
  const dir = mkdtempSync(join(tmpdir(), "northstar-charset-"));
  const engine = new Engine({ dbPath: join(dir, "northstar.db"), tickMs: 25 });
  await engine.start();
  await engine.addChannel(cfg);
  return {
    engine,
    port: engine.mllpPort("cs")!,
    close: async () => {
      await engine.stop();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

test("MSH-18 is read without decoding the rest of the frame", () => {
  // The awkward part of the problem: the declaration lives inside the message
  // it describes. MSH is ASCII by construction, so a byte-preserving read of
  // it finds the field whatever the rest of the frame is in.
  assert.equal(declaredCharset(adt("8859/1", "latin1")), "8859/1");
  assert.equal(declaredCharset(adt("UNICODE UTF-8", "utf8")), "UNICODE UTF-8");
  assert.equal(declaredCharset(adt("", "utf8")), undefined, "an empty MSH-18 declares nothing");
  assert.equal(declaredCharset(Buffer.from("not hl7 at all")), undefined);
});

test("a declared ISO-8859-1 message keeps its accents", () => {
  const decoded = decodeFrame(adt("8859/1", "latin1"));
  assert.equal(decoded.charset, "8859/1");
  const parsed = parseHl7(decoded.text);
  assert.equal(getHl7(parsed, "PID-5.1"), "Bédard");
  assert.equal(getHl7(parsed, "PID-5.2"), "Renée");
  assert.equal(getHl7(parsed, "PID-5.3"), "Thérèse");
});

test("the same bytes read as UTF-8 are refused, not substituted", () => {
  // The whole point. Before this, the U+FFFD substitution happened quietly
  // and the message was stored looking like data.
  assert.throws(
    () => decodeFrame(adt("", "latin1"), "UNICODE UTF-8"),
    (err: Error) => {
      assert.ok(err instanceof CharsetError);
      assert.match(err.message, /not valid UNICODE UTF-8/);
      // The message has to tell an operator what to change.
      assert.match(err.message, /the channel is configured for/);
      return true;
    }
  );
});

test("a channel configured for 8859/1 reads a sender that declares nothing", () => {
  // Most senders declare nothing, so the configured default is what actually
  // carries a real deployment.
  const decoded = decodeFrame(adt("", "latin1"), "8859/1");
  assert.equal(getHl7(parseHl7(decoded.text), "PID-5.1"), "Bédard");
});

test("a declaration in the message beats the channel's configuration", () => {
  // The sender is stating a fact about the bytes it just sent; the config is
  // only a guess about senders that say nothing.
  const decoded = decodeFrame(adt("UNICODE UTF-8", "utf8"), "8859/1");
  assert.equal(decoded.charset, "UNICODE UTF-8");
  assert.equal(getHl7(parseHl7(decoded.text), "PID-5.1"), "Bédard");
});

test("an unsupported character set is refused by name", () => {
  assert.throws(
    () => decodeFrame(adt("JAS2020", "latin1")),
    (err: Error) => {
      assert.match(err.message, /unsupported character set "JAS2020"/);
      assert.match(err.message, /declared in MSH-18/);
      assert.match(err.message, /supported: /, "and says what it would accept");
      return true;
    }
  );
});

test("frames round-trip through the wire encoding", () => {
  for (const charset of ["UNICODE UTF-8", "8859/1"]) {
    const framed = frame("PID|1||x||Bédard^Renée", charset);
    const { frames } = deframe(framed);
    assert.equal(decodeFrame(frames[0], charset).text, "PID|1||x||Bédard^Renée", charset);
  }
});

test("encoding refuses a character the set cannot carry", () => {
  // ᐃᓄᒃᑎᑐᑦ has no ISO-8859-1 representation. Dropping it silently would put
  // a wrong name in an acknowledgement, which is what the sender logs.
  assert.throws(() => encodeFrame("PID|1||x||ᐃᓄᒃᑎᑐᑦ", "8859/1"), /cannot be represented in 8859\/1/);
  // And it survives UTF-8 intact.
  assert.equal(encodeFrame("ᐃᓄᒃᑎᑐᑦ", "UNICODE UTF-8").toString("utf8"), "ᐃᓄᒃᑎᑐᑦ");
});

test("end to end: an 8859/1 admission is stored with its accents intact", async () => {
  const { engine, port, close } = await boot(channel());
  try {
    const bytes = adt("8859/1", "latin1");
    const ack = await mllpSend("127.0.0.1", port, bytes.toString("latin1"), 5_000, "8859/1");
    assert.match(ack, /MSA\|AA/, "a message the engine can read is accepted");

    const stored = engine.db.listMessages({ channelId: "cs" })[0];
    assert.match(stored.raw, /Bédard/, "the stored message is what was sent");
    assert.ok(!stored.raw.includes("�"), "and carries no replacement characters");
    assert.equal(engine.db.verifyChain("cs").ok, true);
  } finally {
    await close();
  }
});

test("end to end: an undecodable frame is rejected, never stored corrupted", async () => {
  // A sender emitting ISO-8859-1 without declaring it, into a channel left on
  // the UTF-8 default. This is the exact configuration that used to corrupt.
  const { engine, port, close } = await boot(channel());
  try {
    const bytes = adt("", "latin1");
    const ack = await mllpSend("127.0.0.1", port, bytes.toString("latin1"), 5_000, "8859/1");

    assert.doesNotMatch(ack, /MSA\|AA/, "it must not be acknowledged as received");
    assert.match(ack, /MSA\|AR/, "and the sender is told it was rejected");
    assert.match(ack, /not valid/, "with a reason an operator can act on");
    assert.match(ack, /\|C1\|/, "referencing the control id, so the sender knows which message");

    assert.equal(engine.db.listMessages({ channelId: "cs" }).length, 0, "nothing corrupted was stored");
  } finally {
    await close();
  }
});

test("end to end: configuring the channel makes that same sender work", async () => {
  // The recovery path. The rejection above is only acceptable because there
  // is something an operator can do about it.
  const { engine, port, close } = await boot(channel("8859/1"));
  try {
    const ack = await mllpSend("127.0.0.1", port, adt("", "latin1").toString("latin1"), 5_000, "8859/1");
    assert.match(ack, /MSA\|AA/);
    assert.match(engine.db.listMessages({ channelId: "cs" })[0].raw, /Bédard\^Renée\^Thérèse/);
  } finally {
    await close();
  }
});

test("the acknowledgement goes back in the character set the sender used", async () => {
  // An ACK echoes fields from the message. Replying in UTF-8 to a sender that
  // speaks ISO-8859-1 puts mojibake in their log, which is where they look
  // when reconciling what was received.
  const { port, close } = await boot(channel("8859/1"));
  try {
    const raw =
      [
        "MSH|^~\\&|MÉDITECH|STANTON|PORTAGE|GNWT|20260805120000||ADT^A01^ADT_A01|C2|P|2.5.1",
        "PID|1||NT445566^^^NWT^JHN||Bédard^Renée||19750612|F",
        "PV1|1|I",
      ].join("\r") + "\r";
    const ack = await mllpSend("127.0.0.1", port, raw, 5_000, "8859/1");
    assert.match(ack, /MSA\|AA/);
    assert.match(ack, /MÉDITECH/, "the sending application is echoed back readable");
    assert.ok(!ack.includes("�"));
  } finally {
    await close();
  }
});
