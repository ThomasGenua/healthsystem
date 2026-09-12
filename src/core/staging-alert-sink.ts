import { createServer } from "node:http";
/** Synthetic receiver only: keeps no labels, annotations, URLs or patient data. */
export function createStagingAlertSink() {
  const allowed = new Set(["NorthstarServiceDown", "NorthstarScannerBacklog", "NorthstarDeliveryFailures", "NorthstarBackupFailed", "NorthstarBackupStale"]);
  const events: Array<{ name: string; status: "firing" | "resolved" }> = [];
  return createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    if (req.method === "GET" && req.url === "/events") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ syntheticOnly: true, events })); return;
    }
    if (req.method !== "POST" || req.url !== "/alerts") { res.writeHead(404).end(); return; }
    let size = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 65536) { res.writeHead(413).end(); req.destroy(); return; }
        chunks.push(bytes);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!Array.isArray(body.alerts) || body.alerts.length > 20) { res.writeHead(400).end(); return; }
      for (const alert of body.alerts) {
        const name = alert?.labels?.alertname;
        if (allowed.has(name) && ["firing", "resolved"].includes(alert.status)) {
          events.push({ name, status: alert.status });
          if (events.length > 100) events.shift();
        }
      }
      res.writeHead(200).end();
    } catch { res.writeHead(400).end(); }
  });
}
