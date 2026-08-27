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
 * nothing. Set NORTHSTAR_TEST_CHROME to point at one.
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
    process.env.NORTHSTAR_TEST_CHROME,
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  return candidates.find((p) => existsSync(p));
}

const CHROME = findChrome();

/** A patient, a clinician and an author for the hostile clinical fixtures. */
const HOSTILE_PATIENT = "NT900001";
const HOSTILE_CLINICIAN = "dr-tetso";
const HOSTILE_ACTOR = { actorId: HOSTILE_CLINICIAN, actorKind: "practitioner" };

test(
  "hostile message content does not execute in the admin console",
  { skip: CHROME ? false : "no chromium found; set NORTHSTAR_TEST_CHROME to run this" },
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

    const dir = mkdtempSync(join(tmpdir(), "northstar-xss-"));
    const profile = mkdtempSync(join(tmpdir(), "northstar-chrome-"));
    const engine = new Engine({ dbPath: join(dir, "northstar.db"), tickMs: 25 });
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

      // The clinical console renders a second class of hostile input, and it
      // does not arrive over MLLP. A patient's name comes from an ADT feed, but
      // a referral's service, a task's title, an acknowledgement action and a
      // break-glass reason are free text somebody types — a clerk, a
      // clinician, or anybody who has reached a form. Every one of them is
      // rendered into the chart, the worklist or the break-glass queues, and
      // several land inside single-quoted onclick attributes.
      //
      // Seeded straight into the stores rather than through a channel because
      // that is genuinely how they arrive: these are written by the API, not
      // mapped from a message.
      const t = engine.forTenant("default");
      const evilName = payloads[0];
      t.clinical.record({
        entryType: "Patient",
        patientId: HOSTILE_PATIENT,
        content: {
          resourceType: "Patient",
          identifier: [{ system: "urn:jhn", value: HOSTILE_PATIENT }],
          name: [{ family: evilName, given: [payloads[3]] }],
        },
        authorId: "adt-feed",
        authorKind: "device",
      });
      t.meds.recordAllergy({
        patientId: HOSTILE_PATIENT,
        display: payloads[5],
        ingredient: "penicillin",
        criticality: "high",
        by: HOSTILE_ACTOR,
      });
      const ord = t.orders.create({
        patientId: HOSTILE_PATIENT,
        category: "lab",
        code: "2823-3",
        display: payloads[1],
        indication: payloads[2],
        by: HOSTILE_ACTOR,
      });
      t.orders.place(ord.id, { ...HOSTILE_ACTOR, responsibleId: HOSTILE_CLINICIAN });
      t.orders.report({
        patientId: HOSTILE_PATIENT,
        orderId: ord.id,
        code: "2823-3",
        display: payloads[1],
        value: payloads[4],
        abnormalFlag: "critical-high",
        reportedBy: "analyser",
      });
      t.referrals.create({
        patientId: HOSTILE_PATIENT,
        fromService: payloads[2],
        toService: payloads[0],
        indication: payloads[3],
        by: HOSTILE_ACTOR,
      });
      t.tasks.create({ kind: "administrative", title: payloads[5], by: HOSTILE_ACTOR, ownerId: HOSTILE_CLINICIAN });
      // Narrowed, not a full lockbox. An unscoped directive would make the
      // chart answer 403 and render a refusal banner containing nothing
      // hostile — so this test would pass while proving nothing about the tab
      // it was added to cover. Scoped, the chart renders: every panel the
      // patient did not lock, plus the withheld one, which is itself a render
      // path worth driving.
      t.consent.record({
        patientId: HOSTILE_PATIENT,
        kind: "withhold-all",
        scope: ["DocumentReference"],
        by: HOSTILE_ACTOR,
        reason: payloads[0],
      });
      t.consent.breakGlass({
        patientId: HOSTILE_PATIENT,
        by: { actorId: payloads[3], actorKind: "practitioner" },
        reason: `${payloads[0]} — unresponsive on arrival, need the allergy list now`,
      });

      chrome = spawn(CHROME!, [
        "--headless=new",
        "--remote-debugging-port=0",
        "--no-sandbox",
        "--disable-gpu",
        // Containers give /dev/shm 64 MB, which Chromium outgrows on startup
        // and then dies without printing an endpoint. This is the difference
        // between the test running on a CI runner and timing out on one.
        "--disable-dev-shm-usage",
        `--user-data-dir=${profile}`,
        "about:blank",
      ], {
        // Its own process group. Chromium forks a zygote, a GPU process and a
        // renderer per tab, and none of them are children of the signal sent
        // to the launcher — so killing only the parent leaves them running and
        // still writing to the profile directory, which is what makes the
        // profile refuse to delete underneath the cleanup below.
        detached: true,
      });
      const wsUrl = await new Promise<string>((resolve, reject) => {
        let buf = "";
        let exited = "";
        const timer = setTimeout(
          // Chromium's own output, not just "it didn't start". A browser that
          // will not launch has always said why, and swallowing that turns a
          // five-minute fix into a guess.
          () => reject(new Error(`chromium did not report a devtools endpoint${exited}\n${buf.slice(-800)}`)),
          45_000
        );
        chrome!.once("exit", (code, signal) => {
          exited = ` (process exited: code ${code}, signal ${signal})`;
        });
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
      const seen: Record<string, boolean> = {};

      // What each tab needs before it will render anything. The clinical tabs
      // are driven by a patient or a clinician the user has chosen, so without
      // this they paint an empty form and the payloads never reach the DOM —
      // which would pass, having proved nothing.
      const prep: Record<string, string> = {
        Chart: `sessionStorage.setItem('northstar.patient',${JSON.stringify(HOSTILE_PATIENT)});`,
        Worklist: `localStorage.setItem('northstar.clinician',${JSON.stringify(HOSTILE_CLINICIAN)});`,
      };

      for (const tab of ["Channels", "Messages", "FHIR", "Audit", "Chart", "Worklist", "Break-glass", "Privacy"]) {
        await cdp("Page.navigate", { url: `${base}/#${tab}` }, S);
        // Every tab fills itself from a fetch, so how long that takes is a
        // property of the runner rather than of the page. A fixed wait is
        // therefore a guess that is right on a quiet machine and wrong on a
        // loaded one — and when it is wrong this test does not fail loudly,
        // it fails on its own honesty check, having proved nothing. So it
        // waits for the content instead. Messages is the tab that must show
        // the payload, and is given room accordingly; the rest are provoked
        // once they have settled.
        const budgetMs = tab === "Messages" ? 30_000 : 4_000;
        const out = await cdp(
          "Runtime.evaluate",
          {
            expression: `(async()=>{
              const HOSTILE = /&lt;img|&lt;script|&lt;svg|onmouseover/i;
              ${prep[tab] ?? ""}
              if(typeof go==='function') go(${JSON.stringify(tab)});
              const deadline = Date.now() + ${budgetMs};
              let escaped = false;
              while(Date.now() < deadline){
                await new Promise(r=>setTimeout(r,100));
                if(HOSTILE.test(document.body.innerHTML)){ escaped = true; break; }
              }
              for(const el of document.querySelectorAll('*')) el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
              for(const row of document.querySelectorAll('tr.row')) row.click();
              await new Promise(r=>setTimeout(r,400));
              return JSON.stringify({
                escaped: escaped || HOSTILE.test(document.body.innerHTML),
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
        seen[tab] = v.escaped === true;
        assert.equal(v.live ?? 0, 0, `${tab} rendered an element built from message content`);
      }

      ws.close();

      // The load-bearing assertion, and the one that keeps this honest: the
      // hostile text has to have reached the page for its absence of effect
      // to mean anything. Named to one tab rather than "somewhere", because
      // the messages are in the database before the browser starts — so this
      // is a fact about the page, and a miss is a real failure rather than a
      // slow runner.
      assert.ok(
        seen.Messages,
        "the hostile payload never rendered on the Messages tab, so this proved nothing about the escaping"
      );
      // The same honesty check for the clinical console. These tabs render a
      // different class of hostile input — free text somebody typed rather
      // than a mapped message field — and a tab that painted an empty form
      // would sail through the beacon check having escaped nothing.
      for (const tab of ["Chart", "Worklist", "Break-glass"]) {
        assert.ok(seen[tab], `the hostile payload never rendered on the ${tab} tab, so this proved nothing about it`);
      }
      assert.deepEqual(beacons, [], "message content executed in the admin console");
    } finally {
      if (chrome) {
        // The whole group, not the launcher. Signalling the negative pid
        // reaches the zygote and the renderers too; without them the profile
        // is still being written to when the removal below runs.
        const exited = new Promise<void>((r) => chrome!.once("exit", () => r()));
        try {
          if (chrome.pid) process.kill(-chrome.pid, "SIGKILL");
        } catch {
          // Already gone, or never got a group. Fall back to the launcher.
        }
        chrome.kill("SIGKILL");
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      }
      await api.close();
      await engine.stop();
      await new Promise<void>((r) => canary.close(() => r()));
      rmSync(dir, { recursive: true, force: true });

      // Best effort, and deliberately not an assertion. A Chromium profile
      // that will not delete is a temp directory on a CI runner; it says
      // nothing about whether hostile message content executed, and the
      // assertions that answer that question have already run by the time
      // this does. Failing here would report "hostile message content does
      // not execute in the admin console: FAILED" because of an ENOTEMPTY,
      // which is worse than a stale directory in /tmp by every measure —
      // people stop reading a check that cries wolf.
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      } catch (err) {
        console.warn(`could not remove the chromium profile at ${profile}: ${(err as Error).message}`);
      }
    }
  }
);
