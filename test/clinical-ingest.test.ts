/**
 * An interface message landing on a chart.
 *
 * This is what makes the provenance columns earn their place: an entry that
 * came from a Dynacare ORU should say so, name the message that produced it,
 * and — when the same result arrives again, as results do — not become a
 * second entry.
 *
 * The retransmission case is the one that decides whether this is usable. A
 * hospital interface resends: on reconnect, on replay from a DLQ, on a nightly
 * repeat of the day's admissions. A chart that grew a version per resend would
 * bury the two amendments that mattered under four hundred that said nothing,
 * and "show me what changed" would stop being answerable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/core/engine.ts";
import { mllpSend } from "../src/hl7/mllp.ts";
import { until } from "./helpers.ts";
import type { ChannelConfig, MappingDoc } from "../src/types.ts";

const CHANNEL: ChannelConfig = {
  id: "adt",
  name: "admissions",
  source: { type: "mllp", port: 0 },
  pipeline: [{ type: "transform.mapping", mapping: "adt-patient" }],
  destinations: [
    {
      id: "chart",
      type: "clinical",
      patientPath: "identifier[0].value",
      ordered: true,
      maxAttempts: 3,
      backoffBaseMs: 10,
    },
  ],
};

const adt = (family: string, control: string) =>
  [
    `MSH|^~\\&|WOLF|YKPCC|PORTAGE|GNWT|20260805120000||ADT^A01^ADT_A01|${control}|P|2.5.1`,
    `PID|1||NT123456^^^NWT^JHN||${family}^Marie^Louise||19840317|F`,
    "PV1|1|I",
  ].join("\r") + "\r";

async function boot(channel: ChannelConfig = CHANNEL) {
  const dir = mkdtempSync(join(tmpdir(), "northstar-cling-"));
  const engine = new Engine({ dbPath: join(dir, "northstar.db"), tickMs: 25 });
  await engine.start();
  engine.registerMapping(
    JSON.parse(readFileSync(new URL("../mappings/adt-patient.json", import.meta.url), "utf8")) as MappingDoc
  );
  await engine.addChannel(channel);
  return {
    engine,
    chart: engine.forTenant("default").clinical,
    port: engine.mllpPort(channel.id)!,
    close: async () => {
      await engine.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("an admission lands on a chart, naming the message it came from", async () => {
  const { engine, chart, port, close } = await boot();
  try {
    assert.match(await mllpSend("127.0.0.1", port, adt("Beaulieu", "M1"), 5_000), /MSA\|AA/);
    await until(() => chart.chart("NT123456").length === 1);

    const [entry] = chart.chart("NT123456");
    assert.equal(entry.entry_type, "Patient");
    assert.equal(entry.patient_id, "NT123456");
    assert.equal(JSON.parse(entry.content).name[0].family, "Beaulieu");
    assert.equal(entry.author_kind, "device", "an interface is not a clinician");
    assert.equal(entry.author_id, "chart");

    // The provenance that makes reconciliation possible: the entry names the
    // stored message, and that message is still there with its own lineage.
    const message = engine.db.getMessage(entry.source_message_id!);
    assert.ok(message, "the entry must point at a message that exists");
    assert.match(message!.raw, /Beaulieu/);
    assert.equal(engine.db.verifyChain("adt").ok, true);
    assert.equal(chart.verifyChart("NT123456").ok, true);
  } finally {
    await close();
  }
});

test("the same admission sent again does not grow the chart", async () => {
  // The case that decides whether this is usable at all.
  const { chart, port, close } = await boot();
  try {
    for (const control of ["M1", "M2", "M3", "M4"]) {
      assert.match(await mllpSend("127.0.0.1", port, adt("Beaulieu", control), 5_000), /MSA\|AA/);
    }
    await until(() => chart.patients().length === 1);
    await new Promise((r) => setTimeout(r, 300));

    const [record] = chart.chart("NT123456");
    assert.equal(chart.history(record.record_id).length, 1, "four identical messages are one assertion");
    assert.equal(chart.verifyChart("NT123456").checked, 1);
  } finally {
    await close();
  }
});

test("a changed admission amends, keeping what the chart said before", async () => {
  // An A08 correcting a misspelled name. The old spelling is what the chart
  // said when anything acted on it, so it has to remain readable.
  const { chart, port, close } = await boot();
  try {
    await mllpSend("127.0.0.1", port, adt("Beauliue", "M1"), 5_000);
    await until(() => chart.chart("NT123456").length === 1);

    await mllpSend("127.0.0.1", port, adt("Beaulieu", "M2"), 5_000);
    await until(() => chart.chart("NT123456")[0].version === 2);

    const [current] = chart.chart("NT123456");
    const history = chart.history(current.record_id);
    assert.equal(history.length, 2, "one record, two versions — not two records");
    assert.equal(JSON.parse(history[0].content).name[0].family, "Beauliue", "the misspelling is still readable");
    assert.equal(JSON.parse(history[1].content).name[0].family, "Beaulieu");
    assert.equal(history[0].superseded, true);
    assert.match(history[1].amendment_reason ?? "", /updated by message /, "and it names what changed it");
    assert.equal(chart.verifyChart("NT123456").ok, true);
  } finally {
    await close();
  }
});

test("an interface cannot reinstate a record a clinician retracted", async () => {
  // The routine nightly resend must not undo a clinical judgement. This is
  // the reason ingest treats entered-in-error as terminal rather than as one
  // more state to move out of.
  const { chart, port, close } = await boot();
  try {
    await mllpSend("127.0.0.1", port, adt("Beaulieu", "M1"), 5_000);
    await until(() => chart.chart("NT123456").length === 1);

    const [entry] = chart.chart("NT123456");
    chart.retract(entry.record_id, {
      authorId: "dr-tetso",
      authorKind: "practitioner",
      reason: "merged into the correct patient",
    });
    assert.equal(chart.chart("NT123456").length, 0);

    // The feed resends, with different content, as it would the next night.
    await mllpSend("127.0.0.1", port, adt("Beaulieu-Smith", "M2"), 5_000);
    await new Promise((r) => setTimeout(r, 400));

    assert.equal(chart.chart("NT123456").length, 0, "the retraction stands");
    const history = chart.history(entry.record_id);
    assert.equal(history[history.length - 1].status, "entered-in-error");
    assert.equal(chart.verifyChart("NT123456").ok, true);
  } finally {
    await close();
  }
});

test("a message with no patient identifier is dead-lettered, not filed somewhere", async () => {
  // Guessing whose chart an entry belongs on is how a result reaches the wrong
  // patient. The delivery fails loudly and an operator sees it in the DLQ.
  const { engine, chart, port, close } = await boot();
  try {
    const noPid =
      [
        "MSH|^~\\&|WOLF|YKPCC|PORTAGE|GNWT|20260805120000||ADT^A01^ADT_A01|M9|P|2.5.1",
        "PID|1||||Nameless^Patient||19840317|F",
        "PV1|1|I",
      ].join("\r") + "\r";
    await mllpSend("127.0.0.1", port, noPid, 5_000).catch(() => "");

    await until(() => engine.db.listDeliveries({ channelId: "adt", state: "dead" }).length === 1, 10_000);
    const [dead] = engine.db.listDeliveries({ channelId: "adt", state: "dead" });
    assert.match(dead.last_error ?? "", /no patient identifier/);
    assert.equal(chart.patients().length, 0, "and nothing was filed against a guess");
  } finally {
    await close();
  }
});

test("a clinical destination without a patient path is refused at configuration", async () => {
  const { engine, close } = await boot();
  try {
    await assert.rejects(
      () =>
        engine.addChannel({
          id: "bad",
          name: "bad",
          source: { type: "http", path: "bad" },
          destinations: [{ id: "chart", type: "clinical" } as never],
        }),
      /requires patientPath/
    );
  } finally {
    await close();
  }
});

test("results for one patient are separate records, not one overwritten", async () => {
  // Identity has to distinguish records that repeat per patient. With the
  // patient as the only key, every result would amend the last one and a chart
  // would hold exactly one observation forever — which is the shape of bug
  // that looks like working software until someone asks for a trend.
  const { engine, chart, close } = await boot({
    id: "lab",
    name: "lab results",
    source: { type: "http", path: "lab" },
    destinations: [
      {
        id: "chart",
        type: "clinical",
        patientPath: "subject.identifier.value",
        identity: ["subject.identifier.value", "code.coding[0].code"],
        effectivePath: "effectiveDateTime",
        ordered: true,
        maxAttempts: 3,
        backoffBaseMs: 10,
      },
    ],
  });
  try {
    const observation = (code: string, value: number, at: string) =>
      JSON.stringify({
        resourceType: "Observation",
        subject: { identifier: { value: "NT123456" } },
        code: { coding: [{ system: "http://loinc.org", code }] },
        valueQuantity: { value, unit: "mmol/L" },
        effectiveDateTime: at,
      });

    engine.ingest("lab", observation("4548-4", 7.4, "2026-08-05T09:00:00Z"), "application/fhir+json", "http");
    engine.ingest("lab", observation("2339-0", 6.1, "2026-08-05T09:00:00Z"), "application/fhir+json", "http");
    await until(() => chart.chart("NT123456").length === 2, 10_000);

    // A corrected result for one of them amends that one only.
    engine.ingest("lab", observation("4548-4", 7.6, "2026-08-05T09:00:00Z"), "application/fhir+json", "http");
    await until(() => chart.chart("NT123456").some((e) => e.version === 2), 10_000);

    const entries = chart.chart("NT123456");
    assert.equal(entries.length, 2, "two analytes remain two records");
    const a1c = entries.find((e) => JSON.parse(e.content).code.coding[0].code === "4548-4")!;
    const glucose = entries.find((e) => JSON.parse(e.content).code.coding[0].code === "2339-0")!;
    assert.equal(JSON.parse(a1c.content).valueQuantity.value, 7.6);
    assert.equal(a1c.version, 2, "the corrected analyte amended");
    assert.equal(glucose.version, 1, "and the other was left alone");

    // Effective time is carried, so a trend is plotted against when the
    // sample was taken rather than when the message happened to arrive.
    assert.equal(a1c.effective_at, "2026-08-05T09:00:00Z");
    assert.equal(chart.verifyChart("NT123456").ok, true);
  } finally {
    await close();
  }
});
