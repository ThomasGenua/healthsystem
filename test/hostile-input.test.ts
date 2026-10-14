/**
 * Input from somebody who is not being helpful.
 *
 * An interface engine's whole job is to accept bytes from systems it does
 * not control, and MLLP has no authentication at all: anything that can
 * open a TCP socket to the listener can hand it 16 MiB. So the parser's
 * contract is not "handles well-formed HL7" — it is that no input, however
 * hostile or however broken, hangs the process, corrupts a value into
 * something that reads as valid, or gets a caller's mistake reported as
 * ours.
 *
 * The four things these pin were all found by feeding the parser rubbish:
 * a quadratic trim that a single frame could park the engine on for hours,
 * a hex escape that turned unparseable input into NUL bytes, a date
 * conversion that produced the thirteenth month, and an acknowledgement
 * that echoed a control identifier without escaping it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAck, getHl7, hl7DateToIso, parseHl7, serializeHl7, unescapeHl7 } from "../src/hl7/parser.ts";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { AuthGate } from "../src/auth/gate.ts";

const MSH = "MSH|^~\\&|LAB|SITE|NORTHSTAR|SITE|20260101120000||ADT^A01|MSG0001|P|2.5.1";
/** Written this way so the literal never appears in a source file or a diff. */
const NUL = String.fromCharCode(0);

test("a frame of carriage returns does not park the engine on it", () => {
  // `.replace(/\r+$/, "")` is quadratic when a non-CR character follows the
  // run: the engine restarts the greedy match at every position inside it,
  // and `$` fails every time. Measured on the code that had it: 20k CRs took
  // 325ms, 40k took 1.3s, 80k took 5.2s — and the MLLP frame limit is 16 MiB,
  // which extrapolates past two days of one thread pegged, from one frame
  // that needs no credential.
  //
  // The budget is deliberately loose. A linear parse of this does a few
  // milliseconds of work, so a second is a hundredfold margin against a slow
  // or loaded machine and still fails instantly on anything quadratic.
  const message = `${MSH}\r` + "\r".repeat(400_000) + "PID|1||NT123456";
  const started = process.hrtime.bigint();
  const parsed = parseHl7(message);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  assert.ok(ms < 1000, `parsing 400k empty segments took ${ms.toFixed(0)}ms`);
  assert.equal(parsed.segments.length, 2, "and the empty segments are still dropped");
  assert.equal(getHl7(parsed, "PID-3"), "NT123456");
});

test("an escape that is not decodable stays text, and never becomes a NUL", () => {
  const d = parseHl7(MSH).delimiters;
  // `\X..\` is hex data. `parseInt("zz", 16)` is NaN and
  // `String.fromCharCode(NaN)` is U+0000, so unparseable input used to
  // become a NUL byte in the middle of a value — which SQLite stores
  // happily, JSON serialises happily, and every reader afterwards treats as
  // a real character in a patient's name.
  assert.equal(unescapeHl7("Smith\\Xzz\\Jones", d), "Smith\\Xzz\\Jones");
  assert.equal(unescapeHl7("Smith\\X41\\Jones", d), "SmithAJones", "and valid hex still decodes");
  assert.equal(unescapeHl7("Smith\\X4\\Jones", d), "Smith\\X4\\Jones", "an odd number of digits is not hex");
  assert.equal(unescapeHl7("Smith\\X\\Jones", d), "Smith\\X\\Jones", "and neither is none");
  for (const hostile of ["\\Xzz\\", "\\X\\", "\\Xg1\\", "\\X41zz\\", "\\Q\\", "\\"]) {
    assert.ok(!unescapeHl7(hostile, d).includes(NUL), `${JSON.stringify(hostile)} produced a NUL`);
  }
});

test("a date that is not a date is no date, not the thirteenth month", () => {
  assert.equal(hl7DateToIso("20260115"), "2026-01-15");
  assert.equal(hl7DateToIso("20260115143000"), "2026-01-15T14:30:00");
  assert.equal(hl7DateToIso(""), "");

  // Each of these used to come out shaped like a timestamp and be stored as
  // one. `new Date("2026-13-01")` is Invalid Date, so every reader
  // downstream gets NaN from a field that looks populated.
  for (const impossible of ["20261301", "20260231", "20260100", "20260132", "20260115250000", "20260115146000"]) {
    assert.equal(hl7DateToIso(impossible), "", `${impossible} was accepted`);
  }

  // The documented behaviour that must not change: offsets are dropped here
  // and read properly by the lab module, which is why it does its own.
  assert.equal(hl7DateToIso("20260115143000-0500"), "2026-01-15T14:30:00");
  assert.equal(hl7DateToIso("20260115143000.250"), "2026-01-15T14:30:00");
});

test("a control identifier cannot write extra fields into the acknowledgement", () => {
  // Everything else in the ACK is escaped on the way out. MSH-10 was not,
  // and `getHl7` returns the value already unescaped — so a sender could put
  // `\F\` in a control id and have it come back as a live field separator.
  const injected = parseHl7(MSH.replace("MSG0001", "MSG\\F\\AE\\F\\INJECTED"));
  const ack = buildAck(injected, "AA");
  const msa = ack.split("\r").find((l) => l.startsWith("MSA"))!;

  assert.equal(msa.split("|").length, 4, `the MSA grew extra fields: ${msa}`);
  const reparsed = parseHl7(ack);
  assert.equal(getHl7(reparsed, "MSA-1"), "AA", "and the acknowledgement code is still the first thing in it");
  assert.equal(getHl7(reparsed, "MSA-2"), "MSG|AE|INJECTED", "the control id is echoed as one value");
});

test("nothing a sender can put in a frame makes the parser throw something unexpected", () => {
  // A deterministic sweep rather than a random one: a fuzz run that fails
  // only on Tuesdays is not evidence of anything, and a seeded corpus can be
  // reasoned about in review.
  //
  // xorshift32 rather than a linear congruential generator, and that is not
  // a style preference: `seed * 1103515245` leaves the 53-bit integer range
  // for a 31-bit seed, so the low bits round to zero and `% 4` is almost
  // always 0. The first version of this ran 3000 iterations of which 20 had
  // an MSH segment at all, so it exercised the "missing MSH" branch 2839
  // times and everything else never. Every operation below stays in 32 bits.
  let seed = 0x2f6e2b1;
  const rnd = (n: number): number => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed % n;
  };
  const alphabet = ["|", "^", "~", "\\", "&", "\r", "\n", " ", "A", "1", "MSH", "PID", "\\X", "[", "]", "-", "."];

  let parsed = 0;
  let refused = 0;
  for (let i = 0; i < 3000; i++) {
    let raw = rnd(4) === 0 ? "" : `${MSH}\r`;
    for (let j = 0, n = rnd(40); j < n; j++) raw += alphabet[rnd(alphabet.length)];
    let message;
    try {
      message = parseHl7(raw);
    } catch (err) {
      // The only failure a caller of this is written to handle.
      assert.ok(err instanceof Error, `threw a non-Error for ${JSON.stringify(raw)}`);
      refused++;
      continue;
    }
    parsed++;
    // Reading any path out of any message is a total function: a missing
    // path is "", never a throw and never undefined.
    for (const path of ["PID-3", "PID-5.1", "MSH-9", "MSH-10", "PID-3[2].1", "NK1[2]-2", "MSH-1", "MSH-2"]) {
      const value = getHl7(message, path);
      assert.equal(typeof value, "string", `${path} on ${JSON.stringify(raw)} gave ${typeof value}`);
      assert.ok(!value.includes(NUL), `${path} on ${JSON.stringify(raw)} produced a NUL`);
    }
    // And serialising is total too, so an engine that re-emits what it read
    // does not fail on a message it accepted.
    assert.equal(typeof serializeHl7(message), "string");
  }
  // A corpus that stopped exercising both halves would keep passing while
  // testing nothing.
  assert.ok(parsed > 500, `only ${parsed} of the corpus parsed`);
  assert.ok(refused > 100, `only ${refused} of the corpus was refused`);
});

async function boot() {
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  const admin = engine.keys.issue("ops", ["admin"]).key;
  const api = await startApi(engine, 0, "127.0.0.1", { auth: new AuthGate({ keys: engine.keys }) });
  return {
    engine,
    admin,
    base: `http://127.0.0.1:${api.port}`,
    close: async () => {
      await api.close();
      await engine.stop();
    },
  };
}

test("a body that is not JSON is the caller's mistake, not the engine falling over", async () => {
  const s = await boot();
  try {
    for (const body of ["", "{", "not json at all", "[1,2,", '{"a":']) {
      const res = await fetch(`${s.base}/api/channels`, {
        method: "POST",
        headers: { authorization: `Bearer ${s.admin}`, "content-type": "application/json" },
        body,
      });
      // 500 tells a client to retry, and this request will fail identically
      // every time it is retried.
      assert.equal(res.status, 400, `${JSON.stringify(body)} was answered ${res.status}`);
      const parsed = (await res.json()) as { error: string };
      assert.match(parsed.error, /body|json/i);
    }
  } finally {
    await s.close();
  }
});

test("a body too large to read is refused, and refusing it is not a fault", async () => {
  const s = await boot();
  try {
    const res = await fetch(`${s.base}/api/channels`, {
      method: "POST",
      headers: { authorization: `Bearer ${s.admin}`, "content-type": "application/json" },
      body: "x".repeat(26 * 1024 * 1024),
    }).catch(() => undefined);
    // The socket is destroyed at the limit, so a client may see the reset
    // rather than the status. Either is a refusal; what must not happen is
    // the engine reading 26 MiB into memory and then calling it a fault.
    if (res) assert.equal(res.status, 413, "the status that means do not send this again");
  } finally {
    await s.close();
  }
});
