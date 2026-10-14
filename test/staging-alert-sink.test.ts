import { test } from "node:test";
import assert from "node:assert/strict";
import { createStagingAlertSink } from "../src/core/staging-alert-sink.ts";

test("synthetic alert sink records firing/recovery but drops arbitrary payload fields", async () => {
  const server = createStagingAlertSink();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const status of ["firing", "resolved"]) {
      const res = await fetch(base + "/alerts", { method: "POST", body: JSON.stringify({ alerts: [
        { status, labels: { alertname: "NorthstarServiceDown", patient: "do-not-retain" }, annotations: { secret: "do-not-retain" } },
        { status, labels: { alertname: "NorthstarPrivatePatientName" } },
      ] }) });
      assert.equal(res.status, 200); await res.body?.cancel();
    }
    const events = await (await fetch(base + "/events")).json();
    assert.deepEqual(events, { syntheticOnly: true, events: [
      { name: "NorthstarServiceDown", status: "firing" }, { name: "NorthstarServiceDown", status: "resolved" },
    ] });
    const bad = await fetch(base + "/alerts", { method: "POST", body: "not JSON" });
    assert.equal(bad.status, 400); await bad.body?.cancel();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
