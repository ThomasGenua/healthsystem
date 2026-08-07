/**
 * Hostile message content in the admin console, checked in a real browser.
 *
 * MLLP sources are unauthenticated — the protocol has nothing to authenticate
 * with, and the README says so. That makes anything reaching the admin UI from
 * a message unauthenticated input rendered in the browser session of the one
 * person holding an admin key. If a payload executes there it runs with that
 * key, and the engine's entire authorisation model is beside the point.
 *
 * Reading the escaping is not enough to know this. `esc()` is applied by hand
 * at forty-odd sites, and being wrong at one of them is the whole bug — so
 * this ingests genuinely hostile HL7 over MLLP, loads the real page, drives
 * every tab, and watches a canary server that only something executing could
 * reach.
 *
 * The test also asserts the payloads reached the DOM. Without that it would
 * pass just as well if the render path were never exercised, which is the
 * failure mode of every security test that has never seen the thing it guards
 * against.
 *
 * Skipped where no Chromium is installed, rather than quietly asserting
 * nothing. Set PORTAGE_TEST_CHROME to point at one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/core/engine.ts";
import { startApi } from "../src/api/admin.ts";
import { mllpSend } from "../src/hl7/mllp.ts";
import { until } from "./helpers.ts";
import type { MappingDoc } from "../src/types.ts";

function findChrome(): string | undefined {
  const candidates = [
    process.env.PORTAGE_TEST_CHROME,
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  return candidates.find((p) => existsSync(p));
}

const CHROME = findChrome();

test(
  "hostile message content does not execute in the admin console",
  { skip: CHROME ? false : "no chromium found; set PORTAGE_TEST_CHROME to run this" },
  async () => {
    // Anything that runs calls this. A hit is proof rather than an inference.
    const beacons: string[] = [];
    const canary = createServer((req, res) => {
      beacons.push(req.url ?? "");
      res.writeHead(200).end("x");
    });
    await new Promise<void>((r) => canary.listen(0, "127.0.0.1", () => r()));
    const canaryPort = (canary.address() as { port: number }).port;
    const beacon = (tag: string) => `fetch('http://127.0.0.1:${canaryPort}/fired-${tag}')`;

    const dir = mkdtempSync(join(tmpdir(), "portage-xss-"));
    const profile = mkdtempSync(join(tmpdir(), "portage-chrome-"));
    const engine = new Engine({ dbPath: join(dir, "portage.db"), tickMs: 25 });
    await engine.start();
    const api = await startApi(engine, 0, "127.0.0.1");
    let chrome: ReturnType<typeof spawn> | undefined;

    try {
      engine.registerMapping(
        JSON.parse(readFileSync(new URL("../mappings/adt-patient.json", import.meta.url), "utf8")) as MappingDoc
      );
      await engine.addChannel({
        id: "hostile",
        name: "hostile",
        source: { type: "mllp", port: 0 },
        pipeline: [{ type: "transform.mapping", mapping: "adt-patient" }],
        destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
      });

      // One payload per context the UI renders a message into: element
      // content, a double-quoted attribute, and a single-quoted one — the last
      // because every id in an onclick sits inside single quotes.
      const payloads = [
        `<img src=x onerror="${beacon("elem")}">`,
        `<script>${beacon("script")}</script>`,
        `" onmouseover="${beacon("dq")}" x="`,
        `' onmouseover='${beacon("sq")}' x='`,
        `');${beacon("break")};//`,
        `<svg/onload=${beacon("svg")}>`,
      ];
      const port = engine.mllpPort("hostile")!;
      for (let i = 0; i < payloads.length; i++) {
        // HL7 delimiters would end the field, so they go; nothing in the
        // payloads above depends on them.
        const evil = payloads[i].replace(/[|^~\\&\r\n]/g, " ");
        const adt =
          [
            `MSH|^~\\&|WOLF|YKPCC|PORTAGE|GNWT|20260805120000||ADT^A04^ADT_A01|X${i}|P|2.5.1`,
            `PID|1||NT${800000 + i}^^^NWT^JHN||${evil}^Marie||19900101|F`,
            "PV1|1|O",
          ].join("\r") + "\r";
        await mllpSend("127.0.0.1", port, adt, 5_000).catch(() => "");
      }
      await until(() => engine.db.listMessages({ channelId: "hostile" }).length === payloads.length);

      chrome = spawn(CHROME!, [
        "--headless=new",
        "--remote-debugging-port=0",
        "--no-sandbox",
        "--disable-gpu",
        `--user-data-dir=${profile}`,
        "about:blank",
      ]);
      const wsUrl = await new Promise<string>((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(() => reject(new Error("chromium did not report a devtools endpoint")), 30_000);
        chrome!.stderr!.on("data", (d: Buffer) => {
          buf += d.toString();
          const m = /ws:\/\/[^\s]+/.exec(buf);
          if (m) {
            clearTimeout(timer);
            resolve(m[0]);
          }
        });
      });

      const ws = new WebSocket(wsUrl);
      await new Promise<void>((r) => (ws.onopen = () => r()));
      let seq = 0;
      const pending = new Map<number, (v: Record<string, unknown>) => void>();
      ws.onmessage = (e: MessageEvent) => {
        const msg = JSON.parse(String(e.data)) as { id?: number };
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)!(msg as Record<string, unknown>);
          pending.delete(msg.id);
        }
      };
      const cdp = (method: string, params: unknown = {}, sessionId?: string) =>
        new Promise<Record<string, unknown>>((r) => {
          const n = ++seq;
          pending.set(n, r);
          ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
        });

      const target = (await cdp("Target.createTarget", { url: "about:blank" })).result as { targetId: string };
      const attached = (await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true }))
        .result as { sessionId: string };
      const S = attached.sessionId;
      await cdp("Page.enable", {}, S);
      await cdp("Runtime.enable", {}, S);

      const base = `http://127.0.0.1:${api.port}`;
      let sawPayloadSomewhere = false;

      for (const tab of ["Channels", "Messages", "FHIR", "Audit"]) {
        await cdp("Page.navigate", { url: `${base}/#${tab}` }, S);
        await new Promise((r) => setTimeout(r, 800));
        const out = await cdp(
          "Runtime.evaluate",
          {
            expression: `(async()=>{
              if(typeof go==='function') go(${JSON.stringify(tab)});
              await new Promise(r=>setTimeout(r,600));
              for(const el of document.querySelectorAll('*')) el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
              for(const row of document.querySelectorAll('tr.row')) row.click();
              await new Promise(r=>setTimeout(r,400));
              return JSON.stringify({
                escaped: /&lt;img|&lt;script|&lt;svg|onmouseover/i.test(document.body.innerHTML),
                live: document.querySelectorAll('img,svg,script[src]').length,
              });
            })()`,
            awaitPromise: true,
          },
          S
        );
        const v = JSON.parse(
          ((out.result as { result?: { value?: string } })?.result?.value ?? "{}") as string
        ) as { escaped?: boolean; live?: number };
        if (v.escaped) sawPayloadSomewhere = true;
        assert.equal(v.live ?? 0, 0, `${tab} rendered an element built from message content`);
      }

      ws.close();

      // The load-bearing assertion, and the one that keeps this honest: the
      // hostile text has to have reached the page for its absence of effect
      // to mean anything.
      assert.ok(sawPayloadSomewhere, "no payload reached the DOM, so this proved nothing about the escaping");
      assert.deepEqual(beacons, [], "message content executed in the admin console");
    } finally {
      if (chrome) {
        // Wait for it to actually be gone: removing the profile while the
        // process is still flushing it fails with ENOTEMPTY, which would fail
        // the test on cleanup and read as a security finding.
        const exited = new Promise<void>((r) => chrome!.once("exit", () => r()));
        chrome.kill("SIGKILL");
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      }
      await api.close();
      await engine.stop();
      await new Promise<void>((r) => canary.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
);
