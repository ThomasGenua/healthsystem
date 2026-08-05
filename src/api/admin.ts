/**
 * Admin and ingest HTTP API. No framework: node:http with a small router.
 *
 * GET  /api/health                       liveness and stats
 * GET  /api/channels                     list channels with runtime state
 * POST /api/channels                     create or replace a channel
 * GET  /api/channels/:id                 channel configuration
 * DELETE /api/channels/:id               stop and remove a channel
 * GET  /api/messages?channel_id&status   browse messages
 * GET  /api/messages/:id                 message with steps and deliveries
 * GET  /api/deliveries?channel_id&state  browse deliveries (state=dead is the DLQ)
 * POST /api/deliveries/:id/replay        requeue a dead, delivered or discarded delivery
 * POST /api/deliveries/:id/discard       discard a dead delivery, releasing ordered flow
 * GET  /api/chain/verify?channel_id      verify the channel hash chain
 * POST /ingest/:path                     ingest into an http-source channel
 * POST /fhir/:resourceType               ingest into matching fhir-source channels
 *
 * FHIR facade (R4 read side of the fhirstore destination):
 * GET  /fhir/metadata                    CapabilityStatement
 * GET  /fhir/:Type?identifier=&_count=   search by identifier token
 * GET  /fhir/:Type/:id                   read one resource
 *
 * Terminology:  GET /api/terminology/{lookup,expand,translate,stats},
 *   GET /fhir/CodeSystem/$lookup, /fhir/ValueSet/$expand, /fhir/ConceptMap/$translate
 * Conformance:  GET /api/conformance/packs, POST /api/conformance/validate,
 *   GET /api/conformance/capability?pack=
 * Subscriptions: GET|POST /fhir/Subscription, GET|DELETE /fhir/Subscription/:id
 * Admin UI:     GET / (single-file, no build step)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import type { Engine } from "../core/engine.ts";
import { checkCapability, toOperationOutcome, validateResource } from "../conformance/validator.ts";
import type { ChannelConfig, MessageRow } from "../types.ts";

let UI_HTML: string | null = null;
function uiHtml(): string {
  if (UI_HTML === null) {
    try {
      UI_HTML = readFileSync(new URL("./ui.html", import.meta.url), "utf8");
    } catch {
      UI_HTML = "<h1>Portage</h1><p>ui.html not found</p>";
    }
  }
  return UI_HTML;
}

const MAX_BODY = 25 * 1024 * 1024;

export interface ApiHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export function startApi(engine: Engine, port: number, host = "0.0.0.0"): Promise<ApiHandle> {
  const server = createServer((req, res) => {
    void route(engine, req, res).catch((err) => {
      send(res, 500, { error: err instanceof Error ? err.message : "internal error" });
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        server,
        port: actual,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function route(engine: Engine, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  if (method === "GET" && (path === "/" || path === "/ui")) {
    const html = uiHtml();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
    res.end(html);
    return;
  }

  if (method === "GET" && path === "/api/health") {
    return send(res, 200, { ok: true, stats: engine.db.stats() });
  }

  if (path === "/api/channels" && method === "GET") {
    return send(res, 200, engine.listChannels());
  }
  if (path === "/api/channels" && method === "POST") {
    const body = await readBody(req);
    const config = JSON.parse(body) as ChannelConfig;
    await engine.addChannel(config);
    return send(res, 201, { ok: true, id: config.id });
  }

  let m = /^\/api\/channels\/([a-z0-9-]+)$/.exec(path);
  if (m) {
    if (method === "GET") {
      const cfg = engine.getChannelConfig(m[1]);
      return cfg ? send(res, 200, cfg) : send(res, 404, { error: "not found" });
    }
    if (method === "DELETE") {
      await engine.removeChannel(m[1]);
      return send(res, 200, { ok: true });
    }
  }

  if (path === "/api/messages" && method === "GET") {
    const rows = engine.db.listMessages({
      channelId: url.searchParams.get("channel_id") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      limit: num(url.searchParams.get("limit")),
    });
    return send(res, 200, rows.map(redactMessage));
  }

  m = /^\/api\/messages\/([0-9a-f-]+)$/.exec(path);
  if (m && method === "GET") {
    const msg = engine.db.getMessage(m[1]);
    if (!msg) return send(res, 404, { error: "not found" });
    return send(res, 200, {
      ...msg,
      steps: engine.db.getSteps(m[1]),
      deliveries: engine.db.deliveriesForMessage(m[1]),
    });
  }

  if (path === "/api/deliveries" && method === "GET") {
    const rows = engine.db.listDeliveries({
      channelId: url.searchParams.get("channel_id") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
      limit: num(url.searchParams.get("limit")),
    });
    return send(res, 200, rows);
  }

  m = /^\/api\/deliveries\/([0-9a-f-]+)\/(replay|discard)$/.exec(path);
  if (m && method === "POST") {
    const ok = m[2] === "replay" ? engine.db.replayDelivery(m[1]) : engine.db.discardDelivery(m[1]);
    return send(res, ok ? 200 : 409, ok ? { ok: true } : { error: `cannot ${m[2]} in current state` });
  }

  if (path === "/api/chain/verify" && method === "GET") {
    const channelId = url.searchParams.get("channel_id");
    if (!channelId) return send(res, 400, { error: "channel_id required" });
    return send(res, 200, engine.db.verifyChain(channelId));
  }

  if (method === "GET" && path === "/api/terminology/lookup") {
    const system = url.searchParams.get("system") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const hit = engine.terminology.lookup(system, code);
    return hit ? send(res, 200, hit) : send(res, 404, { error: "code not found" });
  }
  if (method === "GET" && path === "/api/terminology/expand") {
    return send(res, 200, engine.terminology.expand(url.searchParams.get("valueset") ?? ""));
  }
  if (method === "GET" && path === "/api/terminology/translate") {
    return send(res, 200, {
      matches: engine.terminology.translate({
        code: url.searchParams.get("code") ?? "",
        system: url.searchParams.get("system") ?? undefined,
        map: url.searchParams.get("map") ?? undefined,
        targetSystem: url.searchParams.get("target") ?? undefined,
      }),
    });
  }
  if (method === "GET" && path === "/api/terminology/stats") {
    return send(res, 200, engine.terminology.stats());
  }

  if (method === "GET" && path === "/api/conformance/packs") {
    return send(res, 200, engine.conformance.list());
  }
  if (method === "POST" && path === "/api/conformance/validate") {
    const body = JSON.parse(await readBody(req)) as { pack?: string; resource?: Record<string, unknown> };
    const pack = engine.conformance.get(body.pack ?? "");
    if (!pack) return send(res, 404, { error: `unknown pack: ${body.pack}` });
    if (!body.resource || typeof body.resource !== "object") return send(res, 400, { error: "resource required" });
    const issues = validateResource(pack, body.resource, engine.terminology);
    const errors = issues.filter((i) => i.severity === "error").length;
    return send(res, 200, { ok: errors === 0, errors, outcome: toOperationOutcome(issues) });
  }
  if (method === "GET" && path === "/api/conformance/capability") {
    const pack = engine.conformance.get(url.searchParams.get("pack") ?? "");
    if (!pack) return send(res, 404, { error: "unknown pack" });
    return send(res, 200, checkCapability(pack, engine.fhir.capability(baseUrl(req), "0.3.0")));
  }

  if (method === "GET" && path === "/fhir/CodeSystem/$lookup") {
    const hit = engine.terminology.lookup(url.searchParams.get("system") ?? "", url.searchParams.get("code") ?? "");
    if (!hit) {
      return send(res, 404, {
        resourceType: "OperationOutcome",
        issue: [{ severity: "error", code: "not-found", diagnostics: "code not found" }],
      });
    }
    return send(res, 200, {
      resourceType: "Parameters",
      parameter: [
        { name: "name", valueString: hit.system },
        { name: "display", valueString: hit.display ?? "" },
      ],
    });
  }
  if (method === "GET" && path === "/fhir/ValueSet/$expand") {
    const id = url.searchParams.get("url") ?? url.searchParams.get("valueset") ?? "";
    const exp = engine.terminology.expand(id);
    return send(res, 200, {
      resourceType: "ValueSet",
      id: exp.id,
      expansion: { timestamp: new Date().toISOString(), total: exp.total, contains: exp.codes },
    });
  }
  if (method === "GET" && path === "/fhir/ConceptMap/$translate") {
    const matches = engine.terminology.translate({
      code: url.searchParams.get("code") ?? "",
      system: url.searchParams.get("system") ?? undefined,
      map: url.searchParams.get("map") ?? undefined,
      targetSystem: url.searchParams.get("target") ?? undefined,
    });
    return send(res, 200, {
      resourceType: "Parameters",
      parameter: [
        { name: "result", valueBoolean: matches.length > 0 },
        ...matches.map((c) => ({
          name: "match",
          part: [
            { name: "equivalence", valueCode: c.equivalence },
            { name: "concept", valueCoding: { system: c.system, code: c.code, display: c.display } },
          ],
        })),
      ],
    });
  }

  if (path === "/fhir/Subscription" && method === "GET") {
    const rows = engine.subs.list();
    return send(res, 200, {
      resourceType: "Bundle",
      type: "searchset",
      total: rows.length,
      entry: rows.map((r) => ({ fullUrl: `${baseUrl(req)}/fhir/Subscription/${r.id}`, resource: engine.subs.toResource(r) })),
    });
  }
  if (path === "/fhir/Subscription" && method === "POST") {
    try {
      const row = engine.subs.create(JSON.parse(await readBody(req)) as Record<string, unknown>);
      return send(res, 201, engine.subs.toResource(row));
    } catch (err) {
      return send(res, 400, {
        resourceType: "OperationOutcome",
        issue: [{ severity: "error", code: "invalid", diagnostics: err instanceof Error ? err.message : "invalid subscription" }],
      });
    }
  }
  m = /^\/fhir\/Subscription\/([A-Za-z0-9.-]{1,64})$/.exec(path);
  if (m && method === "GET") {
    const row = engine.subs.get(m[1]);
    if (!row) {
      return send(res, 404, {
        resourceType: "OperationOutcome",
        issue: [{ severity: "error", code: "not-found", diagnostics: `Subscription/${m[1]} is not stored` }],
      });
    }
    return send(res, 200, engine.subs.toResource(row));
  }
  if (m && method === "DELETE") {
    return engine.subs.remove(m[1]) ? send(res, 200, { ok: true }) : send(res, 404, { error: "not found" });
  }

  m = /^\/ingest\/([a-z0-9-]+)$/.exec(path);
  if (m && method === "POST") {
    const channel = engine.httpChannel(m[1]);
    if (!channel) return send(res, 404, { error: "no http channel at this path" });
    const body = await readBody(req);
    const ct = req.headers["content-type"] ?? "text/plain";
    const result = engine.ingest(channel.id, body, ct, "http");
    return send(res, result.status === "error" ? 422 : 202, {
      messageId: result.message.id,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
    });
  }

  if (path === "/fhir/metadata" && method === "GET") {
    return send(res, 200, engine.fhir.capability(baseUrl(req), "0.3.0"));
  }

  m = /^\/fhir\/([A-Z][A-Za-z]+)$/.exec(path);
  if (m && method === "GET") {
    const type = m[1];
    const result = engine.fhir.search(type, {
      identifier: url.searchParams.get("identifier") ?? undefined,
      count: num(url.searchParams.get("_count")),
    });
    return send(res, 200, {
      resourceType: "Bundle",
      type: "searchset",
      total: result.total,
      entry: result.resources.map((r) => ({
        fullUrl: `${baseUrl(req)}/fhir/${type}/${String((r as { id?: unknown }).id ?? "")}`,
        resource: r,
      })),
    });
  }

  m = /^\/fhir\/([A-Z][A-Za-z]+)\/([A-Za-z0-9.-]{1,64})$/.exec(path);
  if (m && method === "GET") {
    const resource = engine.fhir.get(m[1], m[2]);
    if (!resource) {
      return send(res, 404, {
        resourceType: "OperationOutcome",
        issue: [{ severity: "error", code: "not-found", diagnostics: `${m[1]}/${m[2]} is not stored` }],
      });
    }
    return send(res, 200, resource);
  }

  m = /^\/fhir\/([A-Za-z]+)$/.exec(path);
  if (m && method === "POST") {
    const body = await readBody(req);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return send(res, 400, { error: "body must be JSON" });
    }
    if (parsed.resourceType !== m[1]) {
      return send(res, 400, { error: `resourceType must be ${m[1]}` });
    }
    const channels = engine.fhirChannels(m[1]);
    if (channels.length === 0) return send(res, 404, { error: "no fhir channel accepts this resource type" });
    const results = channels.map((c) => engine.ingest(c.id, body, "application/fhir+json", "fhir"));
    return send(res, 202, results.map((r) => ({ channelId: r.message.channel_id, messageId: r.message.id, status: r.status })));
  }

  send(res, 404, { error: "not found" });
}

function redactMessage(row: MessageRow): Record<string, unknown> {
  return { ...row, raw: row.raw.length > 500 ? row.raw.slice(0, 500) + "..." : row.raw };
}

function baseUrl(req: IncomingMessage): string {
  return `http://${req.headers.host ?? "localhost"}`;
}

function num(v: string | null): number | undefined {
  if (v == null) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
