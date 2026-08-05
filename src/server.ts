/** Portage entry point. */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "./core/engine.ts";
import { startApi } from "./api/admin.ts";
import { tlsFromEnv } from "./api/tls.ts";
import { AuthGate } from "./auth/gate.ts";
import { JwtVerifier } from "./auth/jwt.ts";
import type { ChannelConfig, MappingDoc } from "./types.ts";

const PORT = parseInt(process.env.PORTAGE_PORT ?? "8686", 10);
const DATA_DIR = process.env.PORTAGE_DATA ?? join(process.cwd(), "data");
const CHANNELS_DIR = process.env.PORTAGE_CHANNELS ?? join(process.cwd(), "channels");
const MAPPINGS_DIR = process.env.PORTAGE_MAPPINGS ?? join(process.cwd(), "mappings");
const TERMINOLOGY_DIR = process.env.PORTAGE_TERMINOLOGY ?? join(process.cwd(), "terminology");
const CONFORMANCE_DIR = process.env.PORTAGE_CONFORMANCE ?? join(process.cwd(), "conformance");

/**
 * Authentication is on unless explicitly switched off. `apikey` is the default
 * because it needs no external infrastructure: if no key exists yet, one is
 * minted at boot and printed once, so `npm start` stays a single command
 * without leaving the API open to anyone who can reach the port.
 */
const AUTH_MODE = (process.env.PORTAGE_AUTH_MODE ?? "apikey").toLowerCase();

function buildAuthGate(engine: Engine): AuthGate {
  if (AUTH_MODE === "off") {
    console.warn("WARNING: PORTAGE_AUTH_MODE=off — the API is unauthenticated and open to anyone who can reach it");
    return new AuthGate();
  }

  const modes = new Set(AUTH_MODE.split(/[+,\s]+/).filter(Boolean));
  const unknown = [...modes].filter((m) => m !== "apikey" && m !== "oauth");
  if (unknown.length) throw new Error(`unknown PORTAGE_AUTH_MODE value(s): ${unknown.join(", ")}`);

  const gate: { keys?: Engine["keys"]; jwt?: JwtVerifier } = {};

  if (modes.has("apikey")) {
    gate.keys = engine.keys;
    if (engine.keys.countActive() === 0) {
      const issued = engine.keys.issue("bootstrap");
      console.log(
        [
          "",
          "  No API key existed, so one was issued for this instance:",
          "",
          `    ${issued.key}`,
          "",
          "  This is the only time it is shown. Store it now.",
          "  Issue more with POST /api/keys, revoke with DELETE /api/keys/:id.",
          "",
        ].join("\n")
      );
    }
  }

  if (modes.has("oauth")) {
    const issuer = process.env.PORTAGE_OIDC_ISSUER;
    if (!issuer) throw new Error("PORTAGE_AUTH_MODE includes oauth but PORTAGE_OIDC_ISSUER is not set");
    gate.jwt = new JwtVerifier({
      issuer,
      audience: process.env.PORTAGE_OIDC_AUDIENCE,
      jwksUri: process.env.PORTAGE_OIDC_JWKS,
    });
    console.log(`oauth enabled: issuer ${issuer}`);
  }

  return new AuthGate(gate);
}

async function main(): Promise<void> {
  const engine = new Engine({ dbPath: join(DATA_DIR, "portage.db") });

  if (existsSync(MAPPINGS_DIR)) {
    for (const f of readdirSync(MAPPINGS_DIR).filter((f) => f.endsWith(".json"))) {
      const doc = JSON.parse(readFileSync(join(MAPPINGS_DIR, f), "utf8")) as MappingDoc;
      engine.registerMapping(doc);
      console.log(`mapping loaded: ${doc.id}`);
    }
  }

  if (existsSync(TERMINOLOGY_DIR)) {
    for (const f of readdirSync(TERMINOLOGY_DIR).filter((f) => f.endsWith(".json"))) {
      const pack = JSON.parse(readFileSync(join(TERMINOLOGY_DIR, f), "utf8"));
      const n = engine.terminology.loadPack(pack);
      console.log(`terminology pack loaded: ${pack.id} (${n.concepts} concepts, ${n.valueSetMembers} valueset members, ${n.mapEntries} map entries)`);
    }
  }

  if (existsSync(CONFORMANCE_DIR)) {
    for (const f of readdirSync(CONFORMANCE_DIR).filter((f) => f.endsWith(".json"))) {
      const pack = JSON.parse(readFileSync(join(CONFORMANCE_DIR, f), "utf8"));
      engine.conformance.register(pack);
      console.log(`conformance pack registered: ${pack.id}`);
    }
  }

  await engine.start();

  if (existsSync(CHANNELS_DIR)) {
    for (const f of readdirSync(CHANNELS_DIR).filter((f) => f.endsWith(".json"))) {
      const cfg = JSON.parse(readFileSync(join(CHANNELS_DIR, f), "utf8")) as ChannelConfig;
      if (!engine.getChannelConfig(cfg.id)) {
        await engine.addChannel(cfg);
        console.log(`channel seeded: ${cfg.id}`);
      }
    }
  }

  const tls = tlsFromEnv({
    certPath: process.env.PORTAGE_TLS_CERT,
    keyPath: process.env.PORTAGE_TLS_KEY,
    caPath: process.env.PORTAGE_TLS_CLIENT_CA,
    requireClientCert: process.env.PORTAGE_TLS_CLIENT_CA !== undefined,
  });

  const api = await startApi(engine, PORT, "0.0.0.0", { auth: buildAuthGate(engine), tls: tls ?? undefined });
  console.log(
    `Portage listening on :${api.port} (${api.tls ? (tls?.mutual ? "mutual TLS" : "TLS") : "plain HTTP"}, auth ${AUTH_MODE})`
  );
  for (const ch of engine.listChannels()) {
    const port = ch.mllpPort ? ` mllp:${ch.mllpPort}` : "";
    console.log(`  channel ${ch.id} [${ch.source}]${port} ${ch.running ? "running" : "stopped"}`);
  }

  const shutdown = async () => {
    console.log("shutting down");
    await api.close();
    await engine.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
