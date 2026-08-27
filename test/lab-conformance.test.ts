/**
 * Reading a laboratory's messages before trusting the interface.
 *
 * The findings that matter here are the ones an interface analyst would raise
 * on a call: no accession number so resends cannot be told apart, two
 * identifiers in PID-3 with nothing saying which is the health number,
 * timestamps with no zone. Each is invisible until real messages meet real
 * parsing, and each has broken a live laboratory feed somewhere.
 *
 * The other property under test is what the report refuses to say. A sample
 * set is not a conformance statement, and a report that could be read as one
 * would be worse than no report.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkConformance, formatReport } from "../src/orders/conformance.ts";
import type { LabProfile } from "../src/orders/hl7.ts";

const P = "NT123456";

function oru(
  opts: {
    placer?: string;
    filler?: string;
    identifiers?: string;
    observedAt?: string;
    obx?: string[];
    panel?: string;
    controlId?: string;
  } = {}
): string {
  const {
    placer = "REQ-77",
    filler = "ACC-1001",
    identifiers = `${P}^^^JHN^JHN`,
    observedAt = "20260824104500-0600",
    panel = "2823-3^Potassium^LN",
    controlId = "MSG-1",
    obx = [`OBX|1|NM|2823-3^Potassium^LN||4.1|mmol/L|3.5-5.1|N|||F|||${observedAt}`],
  } = opts;
  return [
    `MSH|^~\\&|LABAPP|STANTON|PORTAGE|GNWT|20260824104500||ORU^R01|${controlId}|P|2.5.1`,
    `PID|1||${identifiers}||BEAULIEU^MARIE||19840317|F`,
    `ORC|RE|${placer}|${filler}`,
    `OBR|1|${placer}|${filler}|${panel}|||${observedAt}`,
    ...obx,
  ].join("\r");
}

test("a clean message against the generic reading produces no findings", () => {
  const report = checkConformance([oru()]);
  assert.equal(report.messagesParsed, 1);
  assert.equal(report.messagesRefused, 0);
  assert.deepEqual(report.messages[0].findings, []);
  assert.equal(report.messages[0].observationCount, 1);
});

test("a missing accession number is reported as the deduplication problem it is", () => {
  // A laboratory that sends no filler order number cannot have its resends
  // told apart from new results, and it retransmits on every reconnect.
  const report = checkConformance([oru({ filler: "" })]);
  const finding = report.messages[0].findings.find((f) => f.kind === "no-filler-order-number");
  assert.ok(finding, "the finding that costs the most in practice must be raised");
  assert.match(finding!.detail, /retransmission cannot be told from a new result/);
  assert.match(finding!.detail, /Ask the laboratory/, "it names the question to put to them");
});

test("a missing requisition number says the result will not close an order", () => {
  const report = checkConformance([oru({ placer: "" })]);
  const finding = report.messages[0].findings.find((f) => f.kind === "no-placer-order-number");
  assert.ok(finding);
  assert.match(finding!.detail, /file as unsolicited/);
});

test("two identifiers with no declared authority is the ordinary lab mistake, and is named", () => {
  // A laboratory sending the health number and its own accession number in
  // one repeating field is normal. Matching the wrong one finds nobody, or
  // finds somebody else.
  const report = checkConformance([oru({ identifiers: `${P}^^^JHN^JHN~LAB-99887^^^DYNACARE^MR` })]);
  const finding = report.messages[0].findings.find((f) => f.kind === "identifier-authority-undeclared");
  assert.ok(finding);
  assert.match(finding!.detail, /2 identifiers in PID-3/);
  assert.match(finding!.detail, /JHN/);
  assert.match(finding!.detail, /DYNACARE/);
  assert.equal(finding!.blocking, false, "it is answerable by declaring one line of profile");
});

test("a profile expecting an authority the messages never send is blocking", () => {
  // The interface would hold every result for identity — correct behaviour,
  // and an unusable feed. That distinction is the whole point of the flag.
  const profile: LabProfile = { id: "vendor-x", name: "Vendor X", patientAssigningAuthority: "OHIP" };
  const report = checkConformance([oru()], { profile });
  const finding = report.messages[0].findings.find((f) => f.kind === "identifier-ambiguous");
  assert.ok(finding);
  assert.equal(finding!.blocking, true);
  assert.match(finding!.detail, /Every result from this laboratory would be held for identity/);
});

test("timestamps with no zone are reported, because an hour is a shift change", () => {
  const report = checkConformance([
    oru({
      observedAt: "20260824104500",
      obx: ["OBX|1|NM|2823-3^Potassium^LN||4.1|mmol/L|3.5-5.1|N|||F|||20260824104500"],
    }),
  ]);
  const finding = report.messages[0].findings.find((f) => f.kind === "timezone-assumed");
  assert.ok(finding);
  assert.match(finding!.detail, /wrong side of a shift change/);
});

test("a message that will not parse is a finding, not an exception", () => {
  // Fifty messages should produce one report, not fifty round trips.
  const report = checkConformance([oru(), "MSH|^~\\&|ADT|X|Y|Z|20260824||ADT^A01|M2|P|2.5.1", oru({ controlId: "MSG-3" })]);
  assert.equal(report.messagesRead, 3);
  assert.equal(report.messagesParsed, 2);
  assert.equal(report.messagesRefused, 1);
  const unparsed = report.messages[1].findings[0];
  assert.equal(unparsed.kind, "unparsed");
  assert.equal(unparsed.blocking, true);
  assert.match(unparsed.detail, /not a laboratory result message/);
});

test("an unknown result status refuses the message and says why", () => {
  // The parser refuses rather than guessing whether a status means final.
  // The harness surfaces that as the interface question it is.
  const report = checkConformance([
    oru({ obx: ["OBX|1|NM|2823-3^Potassium^LN||4.1|mmol/L|3.5-5.1|N|||Q|||20260824104500-0600"] }),
  ]);
  assert.equal(report.messagesRefused, 1);
  assert.match(report.messages[0].findings[0].detail, /unknown OBX-11 result status/);
});

test("findings are counted by kind across the whole set", () => {
  const report = checkConformance([oru({ filler: "" }), oru({ filler: "", controlId: "MSG-2" }), oru({ placer: "" })]);
  assert.equal(report.byKind["no-filler-order-number"], 2);
  assert.equal(report.byKind["no-placer-order-number"], 1);
});

test("the report never says the interface conforms", () => {
  // The property that keeps this honest. A clean run is the most dangerous
  // moment: it is exactly when somebody wants to call the interface done.
  const report = checkConformance([oru()]);
  assert.deepEqual(report.messages[0].findings, [], "a clean run");
  assert.ok(report.limits.length >= 3, "and it still states what it does not establish");
  assert.ok(
    report.limits.some((l) => /not a statement that the interface conforms/.test(l)),
    "in those words"
  );
  assert.ok(
    report.limits.some((l) => /exercises only what it happens to contain/.test(l)),
    "including that an untested message type is untested"
  );
  assert.ok(
    report.limits.some((l) => /generic standards-conformant reading/.test(l)),
    "and that this was not a vendor profile"
  );

  const text = formatReport(report);
  assert.match(text, /What this does not establish/);
  assert.ok(!/conformant\b(?!.*reading)/i.test(text.split("What this does not establish")[0]), "no verdict above the limits");
});

test("a vendor profile drops the generic-reading caveat but keeps the rest", () => {
  const profile: LabProfile = { id: "vendor-x", name: "Vendor X", fillerOrderPaths: ["OBR-3.1"] };
  const report = checkConformance([oru()], { profile });
  assert.equal(report.profileId, "vendor-x");
  assert.ok(!report.limits.some((l) => /generic standards-conformant reading/.test(l)));
  assert.ok(report.limits.some((l) => /not a statement that the interface conforms/.test(l)));
});

test("labels point a finding at a file somebody can open", () => {
  const report = checkConformance([oru({ filler: "" })], { labels: ["samples/dynacare/potassium-01.hl7"] });
  assert.equal(report.messages[0].label, "samples/dynacare/potassium-01.hl7");
  assert.match(formatReport(report), /samples\/dynacare\/potassium-01\.hl7/);
});
