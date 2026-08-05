/**
 * Meridian simulator. Plays the territorial EHR at the far end of the link:
 * an HTTP endpoint that accepts FHIR resources the way the Meridian Health
 * FHIR server does (POST /fhir/:Type, 201 with the stored id) and records
 * every arrival in order, so a demo can prove nothing was lost and nothing
 * arrived out of sequence. Interface only: the full Meridian stack is
 * React/Express/Postgres and lives in its own repository.
 *
 * Standalone:  node demo/meridian-sim.ts --port 9090
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface ReceivedResource {
  order: number;
  at: string;
  resourceType: string;
  id: string;
  identifier?: string;
  controlId?: string;
}

export interface MeridianSimHandle {
  port: number;
  received: ReceivedResource[];
  close(): Promise<void>;
}

export function startMeridianSim(port = 0): Promise<MeridianSimHandle> {
  const received: ReceivedResource[] = [];
  let order = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = /^\/fhir\/([A-Za-z]+)$/.exec(url.pathname);

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, name: "meridian-sim", received: received.length });
    }
    if (req.method === "GET" && url.pathname === "/fhir/received") {
      return json(res, 200, received);
    }
    if (req.method === "POST" && m) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            resourceType?: string;
            id?: string;
            identifier?: Array<{ value?: string }>;
            meta?: { source?: string };
          };
          order++;
          const rec: ReceivedResource = {
            order,
            at: new Date().toISOString(),
            resourceType: body.resourceType ?? m[1],
            id: body.id ?? `meridian-${order}`,
            identifier: body.identifier?.[0]?.value,
          };
          received.push(rec);
          json(res, 201, { resourceType: rec.resourceType, id: rec.id });
        } catch {
          json(res, 400, { error: "body must be JSON" });
        }
      });
      return;
    }
    json(res, 404, { error: "not found" });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : port,
        received,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/fhir+json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  void startMeridianSim(parseInt(arg("port", "9090")!, 10)).then((h) => {
    console.log(`meridian-sim listening on :${h.port}`);
  });
}
