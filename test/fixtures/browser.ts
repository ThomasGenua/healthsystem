/**
 * A real Chromium, driven over the DevTools protocol.
 *
 * Extracted from portal-browser.test.ts when a second browser test needed
 * the same sixty lines. Nothing here is a testing framework: it is one
 * WebSocket, a request/response map, and the two calls a browser test
 * actually makes — evaluate something, and wait until something is true.
 *
 * `wait()` polls rather than subscribing to events, and swallows the errors
 * it gets while polling, because a navigation destroys the execution context
 * mid-flight and an exception from that is noise rather than a failure. The
 * final throw carries the page's visible text, which is what tells you why
 * a condition never came true.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The first Chromium this machine actually has, or undefined. */
export const chromePath = [
  process.env.NORTHSTAR_TEST_CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((p): p is string => !!p && existsSync(p));

/**
 * Why a browser test is skipped, or `false` to run it.
 *
 * `NORTHSTAR_REQUIRE_BROWSER` turns a missing browser into a failure. CI
 * sets it, so "no Chromium on the runner" fails the job instead of quietly
 * reporting a pass for a journey nobody exercised.
 */
export function browserSkip(): string | false {
  return !chromePath && !process.env.NORTHSTAR_REQUIRE_BROWSER
    ? "Chromium not installed; set NORTHSTAR_TEST_CHROME"
    : false;
}

export interface Browser {
  /** Evaluate an expression in the page and return it by value. */
  evaluate(expression: string): Promise<any>;
  /** Poll an expression until it is truthy, or fail with the page's text. */
  wait(expression: string, timeoutMs?: number): Promise<void>;
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;
  /** Raw DevTools, for the few things evaluate() cannot do. */
  cdp(method: string, params?: Record<string, unknown>): Promise<any>;
  /**
   * Answers the next native dialog -- confirm(), alert(), prompt() -- and
   * resolves with its message. Arm it *before* the action that opens the
   * dialog: while one is open the page is blocked, so the evaluate() that
   * triggered it does not return until this has answered.
   */
  nextDialog(accept: boolean): Promise<string>;
  close(): Promise<void>;
}

export async function launchBrowser(opts: { mobile?: boolean } = {}): Promise<Browser> {
  const chrome = chromePath;
  if (!chrome) throw new Error("no Chromium found; set NORTHSTAR_TEST_CHROME");
  const profile = mkdtempSync(join(tmpdir(), "northstar-portal-browser-"));
  const child: ChildProcess = spawn(
    chrome,
    ["--headless=new", "--remote-debugging-port=0", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }
  );
  let ws: WebSocket | undefined;
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Map<string, Set<(params: any) => void>>();

  const close = async (): Promise<void> => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: ++seq, method: "Browser.close" }));
    // The fallback timer is cleared once the race is decided. Left running,
    // it held the test process open for its full three seconds after every
    // browser test, whichever side of the race had won.
    let fallback: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      new Promise<void>((r) => child.once("exit", () => r())),
      new Promise<void>((r) => { fallback = setTimeout(r, 3000); }),
    ]);
    clearTimeout(fallback);
    for (const req of pending.values()) { clearTimeout(req.timer); req.reject(new Error("browser closing")); }
    ws?.close();
    if (child.exitCode === null) child.kill();
    // Only this test's freshly allocated profile, never the user's browser profile.
    if (resolve(profile).startsWith(resolve(tmpdir()) + "/") || resolve(profile).startsWith(resolve(tmpdir()) + "\\")) {
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      catch { console.warn(`Temporary browser profile retained: ${profile}`); }
    }
  };

  try {
    const endpoint = await new Promise<string>((res, rej) => {
      let output = "";
      const timeout = setTimeout(() => rej(new Error(`Chromium did not start: ${output.slice(-1500)}`)), 20_000);
      child.once("error", (err) => { clearTimeout(timeout); rej(err); });
      child.stderr!.on("data", (chunk) => {
        output += chunk.toString();
        const match = /ws:\/\/[^\s]+/.exec(output);
        if (match) { clearTimeout(timeout); res(match[0]); }
      });
    });
    ws = new WebSocket(endpoint);
    await new Promise<void>((res, rej) => {
      const timeout = setTimeout(() => rej(new Error("DevTools connection timed out")), 10_000);
      ws!.onopen = () => { clearTimeout(timeout); res(); };
      ws!.onerror = () => { clearTimeout(timeout); rej(new Error("DevTools connection failed")); };
    });
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      // An event, not a reply: it has a method and no id.
      if (msg.method && msg.id === undefined) {
        for (const listener of listeners.get(msg.method) ?? []) listener(msg.params);
        return;
      }
      const request = pending.get(msg.id);
      if (!request) return;
      pending.delete(msg.id); clearTimeout(request.timer);
      if (msg.error) request.reject(new Error(JSON.stringify(msg.error))); else request.resolve(msg.result);
    };
    const raw = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> =>
      new Promise((res, rej) => {
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); rej(new Error(`DevTools timeout: ${method}`)); }, 10_000);
        pending.set(id, { resolve: res, reject: rej, timer });
        ws!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });

    const target = await raw("Target.createTarget", { url: "about:blank" });
    const attached = await raw("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const session = attached.sessionId as string;
    const cdp = (method: string, params: Record<string, unknown> = {}) => raw(method, params, session);

    const evaluate = async (expression: string) => {
      const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const wait = async (expression: string, timeoutMs = 15_000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try { if (await evaluate(expression)) return; } catch { /* navigation changes execution context */ }
        await new Promise((r) => setTimeout(r, 75));
      }
      throw new Error(`Browser condition failed: ${expression}\n${await evaluate("document.body.innerText")}`);
    };

    await cdp("Page.enable");
    await cdp("Runtime.enable");
    if (opts.mobile !== false) {
      await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    }
    const nextDialog = (accept: boolean): Promise<string> =>
      new Promise((res, rej) => {
        const timer = setTimeout(() => { off(); rej(new Error("no dialog opened")); }, 15_000);
        const handler = (params: { message: string }) => {
          off();
          clearTimeout(timer);
          cdp("Page.handleJavaScriptDialog", { accept }).then(() => res(params.message), rej);
        };
        const off = () => listeners.get("Page.javascriptDialogOpening")?.delete(handler);
        if (!listeners.has("Page.javascriptDialogOpening")) listeners.set("Page.javascriptDialogOpening", new Set());
        listeners.get("Page.javascriptDialogOpening")!.add(handler);
      });

    return {
      evaluate,
      wait,
      cdp,
      nextDialog,
      navigate: async (url: string) => { await cdp("Page.navigate", { url }); },
      reload: async () => { await cdp("Page.reload"); },
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}
