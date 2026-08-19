/** Portage entry point. */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { encryptionAtRest, shouldWarn } from "./core/atrest.ts";
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

/**
 * node:sqlite is still flagged experimental below Node 24, and durable
 * store-and-forward rests entirely on it — an acknowledgement here means the
 * message is committed to that database.
 *
 * The floor stays at 22.18 rather than being raised, so nobody's deployment
 * breaks on an upgrade. But an operator should not discover this from a
 * footnote after the fact, so it is said out loud, once, at the moment it
 * becomes their problem.
 */
function warnIfSqliteExperimental(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major < 24) {
    console.warn(
      `WARNING: node ${process.versions.node} ships node:sqlite as experimental, and durability rests on it. ` +
        `Node 24+ is recommended for production, where it is stable.`
    );
  }
}

function buildAuthGate(engine: Engine): AuthGate {
  if (AUTH_MODE === "off") {
    console.warn("WARNING: PORTAGE_AUTH_MODE=off — the API is unauthenticated and open to anyone who can reach it");
    return new AuthGate();
  }

  const modes = new Set(AUTH_MODE.split(/[+,\s]+/).filter(Boolean));
  const unknown = [...modes].filter((m) => m !== "apikey" && m !== "oauth");
  if (unknown.length) throw new Error(`unknown PORTAGE_AUTH_MODE value(s): ${unknown.join(", ")}`);

  // The tenant directory, so a suspended custodian's credentials stop working
  // at once rather than at the next restart.
  const gate: { keys?: Engine["keys"]; jwt?: JwtVerifier; tenants?: { getTenant(id: string): { status: string } | undefined } } = {
    tenants: engine.db,
  };

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
  warnIfSqliteExperimental();

  // Said at boot for the same reason the line above is: an operator should
  // not learn from a footnote that the file holding every chart is plain
  // text. Once, loudly, at the moment it becomes their problem.
  const atRest = encryptionAtRest(DATA_DIR);
  if (shouldWarn(atRest)) console.warn(`WARNING: ${atRest.detail}`);

  const days = (v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`retention must be a non-negative number of days, got: ${v}`);
    return n;
  };

  const engine = new Engine({
    dbPath: join(DATA_DIR, "portage.db"),
    validatePack: process.env.PORTAGE_VALIDATE_PACK,
    validateMode: process.env.PORTAGE_VALIDATE_MODE === "annotate" ? "annotate" : "reject",
    retention: {
      redactAfterDays: days(process.env.PORTAGE_REDACT_AFTER_DAYS),
      purgeAfterDays: days(process.env.PORTAGE_PURGE_AFTER_DAYS),
    },
  });

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

  const rate = (v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`rate limit must be a positive number, got: ${v}`);
    return n;
  };

  const api = await startApi(engine, PORT, "0.0.0.0", {
    auth: buildAuthGate(engine),
    tls: tls ?? undefined,
    rateLimit: {
      enabled: process.env.PORTAGE_RATE_LIMIT !== "off",
      authenticatedPerMinute: rate(process.env.PORTAGE_RATE_AUTHENTICATED),
      anonymousPerMinute: rate(process.env.PORTAGE_RATE_ANONYMOUS),
    },
  });
  console.log(
    `Portage listening on :${api.port} (${api.tls ? (tls?.mutual ? "mutual TLS" : "TLS") : "plain HTTP"}, auth ${AUTH_MODE})`
  );
  for (const ch of engine.listChannels()) {
    const port = ch.mllpPort ? ` mllp:${ch.mllpPort}` : "";
    console.log(`  channel ${ch.id} [${ch.source}]${port} ${ch.running ? "running" : "stopped"}`);
  }

  if (!api.limiter.enabled) {
    console.warn("WARNING: PORTAGE_RATE_LIMIT=off — a single client can saturate this node");
  }

  if (engine.retention.enabled) {
    const p = engine.retention.describe();
    console.log(
      `retention: ${p.redactAfterDays !== undefined ? `redact after ${p.redactAfterDays}d` : "no redaction"}` +
        `, ${p.purgeAfterDays !== undefined ? `purge after ${p.purgeAfterDays}d` : "no purge"}`
    );
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
