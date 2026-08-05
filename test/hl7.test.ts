import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildAck,
  countHl7,
  escapeHl7,
  getHl7,
  hl7DateToIso,
  parseHl7,
  serializeHl7,
  unescapeHl7,
} from "../src/hl7/parser.ts";
import { deframe, frame } from "../src/hl7/mllp.ts";

const FIXTURE = readFileSync(new URL("../fixtures/adt_a01.hl7", import.meta.url), "utf8");

test("parses MSH with correct field offsets", () => {
  const msg = parseHl7(FIXTURE);
  assert.equal(getHl7(msg, "MSH-1"), "|");
  assert.equal(getHl7(msg, "MSH-2"), "^~\\&");
  assert.equal(getHl7(msg, "MSH-3"), "WOLF");
  assert.equal(getHl7(msg, "MSH-9.1"), "ADT");
  assert.equal(getHl7(msg, "MSH-9.2"), "A01");
  assert.equal(getHl7(msg, "MSH-10"), "MSG00001");
  assert.equal(getHl7(msg, "MSH-12"), "2.5.1");
});

test("addresses components, subcomponents and repetitions", () => {
  const raw =
    "MSH|^~\\&|A|B|C|D|20260101120000||ADT^A08|X1|P|2.5.1\r" +
    "PID|1||111^^^NWT^JHN~222^^^AB^MR||Doe^Jane&Marie^Q|||F\r";
  const msg = parseHl7(raw);
  assert.equal(getHl7(msg, "PID-3.1"), "111");
  assert.equal(getHl7(msg, "PID-3[2].1"), "222");
  assert.equal(getHl7(msg, "PID-3[2].4"), "AB");
  assert.equal(countHl7(msg, "PID-3"), 2);
  assert.equal(getHl7(msg, "PID-5.2"), "Jane&Marie");
  assert.equal(getHl7(msg, "PID-5.2.2"), "Marie");
  assert.equal(getHl7(msg, "PID-99"), "");
  assert.equal(getHl7(msg, "ZZZ-1"), "");
});

test("round-trips escape sequences", () => {
  const msg = parseHl7(FIXTURE);
  const d = msg.delimiters;
  const literal = "Smith|Jones^&~\\ Ltd";
  const escaped = escapeHl7(literal, d);
  assert.ok(!escaped.includes("|") || escaped.includes("\\F\\"));
  assert.equal(unescapeHl7(escaped, d), literal);
  assert.equal(unescapeHl7("caf\\X65\\", d), "cafe");
});

test("reads escaped values through getHl7", () => {
  const raw = "MSH|^~\\&|A|B|C|D|20260101||ADT^A01|1|P|2.5\rPID|1||X||O\\F\\Neil^Pat\r";
  const msg = parseHl7(raw);
  assert.equal(getHl7(msg, "PID-5.1"), "O|Neil");
});

test("serialize round-trips the fixture", () => {
  const msg = parseHl7(FIXTURE);
  const out = serializeHl7(msg);
  assert.equal(out.replace(/\r+$/, ""), FIXTURE.replace(/\r+$/, ""));
});

test("builds an AA ack echoing the control id and swapping endpoints", () => {
  const msg = parseHl7(FIXTURE);
  const ack = parseHl7(buildAck(msg, "AA"));
  assert.equal(getHl7(ack, "MSA-1"), "AA");
  assert.equal(getHl7(ack, "MSA-2"), "MSG00001");
  assert.equal(getHl7(ack, "MSH-3"), "PORTAGE");
  assert.equal(getHl7(ack, "MSH-5"), "WOLF");
  assert.equal(getHl7(ack, "MSH-9.1"), "ACK");
});

test("rejects non-HL7 input", () => {
  assert.throws(() => parseHl7("{\"resourceType\":\"Patient\"}"));
});

test("hl7 date conversion", () => {
  assert.equal(hl7DateToIso("19840317"), "1984-03-17");
  assert.equal(hl7DateToIso("20260805103000"), "2026-08-05T10:30:00");
  assert.equal(hl7DateToIso("202608051030"), "2026-08-05T10:30:00");
  assert.equal(hl7DateToIso("garbage"), "");
});

test("mllp frames and deframes including partials and coalesced frames", () => {
  const a = frame("MSG-A");
  const b = frame("MSG-B");
  const joined = Buffer.concat([a, b]);
  const { frames, rest } = deframe(joined);
  assert.deepEqual(frames, ["MSG-A", "MSG-B"]);
  assert.equal(rest.length, 0);

  const partial = Buffer.concat([a, b.subarray(0, 3)]);
  const r1 = deframe(partial);
  assert.deepEqual(r1.frames, ["MSG-A"]);
  const whole = Buffer.concat([r1.rest, b.subarray(3)]);
  const r2 = deframe(whole);
  assert.deepEqual(r2.frames, ["MSG-B"]);
});
