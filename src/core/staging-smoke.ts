/** Read-only, unauthenticated boundary checks; never sends chart data or tokens. */
export async function stagingSmoke(origin: string, request: typeof fetch = fetch): Promise<string[]> {
  const url = new URL(origin);
  if (url.origin !== origin || url.username || url.password ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Smoke target must be an exact HTTPS origin, or loopback HTTP origin");
  }
  const passed: string[] = [];
  const get = async (path: string, status: number) => {
    const response = await request(origin + path, { redirect: "error", signal: AbortSignal.timeout(3000) });
    if (response.status !== status) { await response.body?.cancel(); throw new Error(`Smoke check failed: ${path} expected ${status}, received ${response.status}`); }
    return response;
  };
  const health = await (await get("/api/health", 200)).json() as { ok?: boolean; degraded?: boolean };
  if (health.ok !== true || health.degraded === true) throw new Error("Health is not ready or is degraded");
  passed.push("health");
  const page = await get("/me", 200);
  if (!page.headers.get("content-type")?.includes("text/html")) throw new Error("Portal document is not HTML");
  await page.body?.cancel();
  passed.push("portal-document");
  for (const path of ["/api/channels", "/patient/authorities"]) {
    await (await get(path, 401)).body?.cancel();
    passed.push(`unauthenticated-refusal:${path}`);
  }
  // A development issuer must not be available in this staging package.
  await (await get("/dev-idp/.well-known/openid-configuration", 404)).body?.cancel();
  passed.push("development-identity-disabled");
  return passed;
}
