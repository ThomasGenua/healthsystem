/** Northstar entry point. */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { encryptionAtRest, shouldWarn } from "./core/atrest.ts";
import { readEnv, legacyEnvWarning, resolveDbPath, legacyDbNotice } from "./core/naming.ts";
import { RemoteBackup, remoteBackupWarning } from "./core/remote.ts";
import { join } from "node:path";
import { Engine } from "./core/engine.ts";
import { DEFAULT_TENANT } from "./db.ts";
import { startApi } from "./api/admin.ts";
import { tlsFromEnv } from "./api/tls.ts";
import { AuthGate } from "./auth/gate.ts";
import { DevIdentityProvider, devIdpRefusal } from "./auth/dev-idp.ts";
import { JwtVerifier } from "./auth/jwt.ts";
import { SyntheticScanner } from "./patient/intake.ts";
import type { ChannelConfig, MappingDoc } from "./types.ts";

const PORT = parseInt(readEnv("PORT") ?? "8686", 10);
const DATA_DIR = readEnv("DATA") ?? join(process.cwd(), "data");
const CHANNELS_DIR = readEnv("CHANNELS") ?? join(process.cwd(), "channels");
const MAPPINGS_DIR = readEnv("MAPPINGS") ?? join(process.cwd(), "mappings");
const TERMINOLOGY_DIR = readEnv("TERMINOLOGY") ?? join(process.cwd(), "terminology");
const CONFORMANCE_DIR = readEnv("CONFORMANCE") ?? join(process.cwd(), "conformance");
const LABS_DIR = readEnv("LABS") ?? join(process.cwd(), "labs");

/**
 * Authentication is on unless explicitly switched off. `apikey` is the default
 * because it needs no external infrastructure: if no key exists yet, one is
 * minted at boot and printed once, so `npm start` stays a single command
 * without leaving the API open to anyone who can reach the port.
 */
const AUTH_MODE = (readEnv("AUTH_MODE") ?? "apikey").toLowerCase();

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

/** Issues the first operator key, once, when a database has none. */
function bootstrapKey(engine: Engine): void {
  if (engine.keys.countActive() !== 0) return;
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

/**
 * Stands up the development identity provider, or explains why it will not.
 *
 * Returns the provider and the verifier that trusts it, so the caller wires
 * both or neither. There is no state where the endpoints answer and the
 * tokens do not verify, and none where a real issuer is configured alongside
 * a key generated at boot — that combination is refused loudly here rather
 * than producing a deployment that is half on each.
 */
function buildDevIdp(engine: Engine, port: number): { idp: DevIdentityProvider; jwt: JwtVerifier } | null {
  const refusal = devIdpRefusal({ devIdp: readEnv("DEV_IDP"), oidcIssuer: readEnv("OIDC_ISSUER") });
  if (refusal === "not enabled") return null;
  if (refusal) throw new Error(refusal);

  // Loopback, and the port this process is about to listen on: the verifier
  // fetches this JWKS over HTTP from inside the same process.
  const issuer = `http://127.0.0.1:${port}/dev-idp`;
  const audience = readEnv("OIDC_AUDIENCE") ?? "northstar-development";
  const tenantId = readEnv("DEV_IDP_TENANT") ?? DEFAULT_TENANT;

  const idp = new DevIdentityProvider({
    issuer,
    audience,
    // Read per request, so a grant revoked while the picker is on screen
    // takes that person out of it. Bounded to one custodian: a picker that
    // spanned them would enumerate one clinic's delegates to another's.
    liveSubjects: () =>
      engine
        .forTenant(tenantId)
        .patientAccess.liveSubjects()
        .map((s) => ({ ...s, tenantId })),
  });

  console.warn(
    [
      "",
      "  WARNING: NORTHSTAR_DEV_IDP=on — a synthetic identity provider is running.",
      "",
      `    issuer   ${issuer}`,
      `    tenant   ${tenantId}`,
      "",
      "  It mints patient tokens for anyone the clinic has already granted a chart to.",
      "  Its signing key was generated at boot and is never written down, so every token",
      "  it issues stops verifying when this process exits. Never run this in production;",
      "  set NORTHSTAR_OIDC_ISSUER instead and this refuses to start.",
      "",
    ].join("\n")
  );

  return {
    idp,
    jwt: new JwtVerifier({ issuer, audience, jwksUri: `${issuer}/.well-known/jwks.json` }),
  };
}

function buildAuthGate(engine: Engine, dev: { jwt: JwtVerifier } | null): AuthGate {
  if (dev) {
    // The development provider is the identity provider. API keys stay on for
    // the operator console, which is a different surface with a different
    // credential; the patient boundary refuses an API key either way.
    //
    // The bootstrap key is issued here too. Without it a demo comes up with a
    // working portal and no way into the clinic side of it — which is half
    // the journey, and the half that shows the patient's question arriving.
    bootstrapKey(engine);
    return new AuthGate({ keys: engine.keys, jwt: dev.jwt, tenants: engine.db });
  }
  if (AUTH_MODE === "off") {
    console.warn("WARNING: NORTHSTAR_AUTH_MODE=off — the API is unauthenticated and open to anyone who can reach it");
    return new AuthGate();
  }

  const modes = new Set(AUTH_MODE.split(/[+,\s]+/).filter(Boolean));
  const unknown = [...modes].filter((m) => m !== "apikey" && m !== "oauth");
  if (unknown.length) throw new Error(`unknown NORTHSTAR_AUTH_MODE value(s): ${unknown.join(", ")}`);

  // The tenant directory, so a suspended custodian's credentials stop working
  // at once rather than at the next restart.
  const gate: { keys?: Engine["keys"]; jwt?: JwtVerifier; tenants?: { getTenant(id: string): { status: string } | undefined } } = {
    tenants: engine.db,
  };

  if (modes.has("apikey")) {
    gate.keys = engine.keys;
    bootstrapKey(engine);
  }

  if (modes.has("oauth")) {
    const issuer = readEnv("OIDC_ISSUER");
    if (!issuer) throw new Error("NORTHSTAR_AUTH_MODE includes oauth but NORTHSTAR_OIDC_ISSUER is not set");
    // Refusing to boot is the point. This was optional, and an unset audience
    // meant every token the issuer had ever signed was accepted — so the
    // deployments that never set it were the ones running without the check.
    // A site that cannot start is a site somebody fixes; one that starts and
    // accepts another application's tokens is not.
    const audience = readEnv("OIDC_AUDIENCE");
    if (!audience) {
      throw new Error(
        "NORTHSTAR_AUTH_MODE includes oauth but NORTHSTAR_OIDC_AUDIENCE is not set. Without it every token " +
          "this issuer has signed is accepted, including tokens minted for other applications in the same " +
          "directory. Set it to the identifier this deployment is registered under at the issuer."
      );
    }
    gate.jwt = new JwtVerifier({
      issuer,
      audience,
      jwksUri: readEnv("OIDC_JWKS"),
    });
    console.log(`oauth enabled: issuer ${issuer}`);
  }

  return new AuthGate(gate);
}

async function main(): Promise<void> {
  warnIfSqliteExperimental();

  // Which database this boot is about to open, and under which name. Said
  // before anything else touches it: an engine that silently created an empty
  // database next to a full one would come up healthy and serve nobody's
  // chart, and the operator's only clue would be a site that had lost every
  // patient overnight.
  const dbChoice = resolveDbPath(DATA_DIR);
  const dbNotice = legacyDbNotice(dbChoice);
  if (dbNotice) console.log(dbNotice);

  // Said at boot for the same reason the line above is: an operator should
  // not learn from a footnote that the file holding every chart is plain
  // text. Once, loudly, at the moment it becomes their problem.
  const atRest = encryptionAtRest(DATA_DIR);
  if (shouldWarn(atRest)) console.warn(`WARNING: ${atRest.detail}`);

  // Not a warning: the old names are supported, not deprecated-with-a-deadline.
  // But an operator renaming their unit file should be able to see which ones
  // are still in play without grepping for them.
  const envNotice = legacyEnvWarning();
  if (envNotice) console.log(envNotice);

  // Same reason, same moment: an operator should not learn from a footnote
  // that every snapshot still lives on the disk that is about to die.
  let remote: RemoteBackup | undefined;
  try {
    remote = RemoteBackup.fromEnv();
    const warning = remoteBackupWarning(remote.status());
    if (warning) console.warn(`WARNING: ${warning}`);
  } catch (err) {
    // Half-configured (a URI without a key, s3:// without credentials) is
    // refused at boot rather than discovered on the first backup, when the
    // local snapshot would already look like success.
    throw err;
  }

  const days = (v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`retention must be a non-negative number of days, got: ${v}`);
    return n;
  };

  // Uploads stay quarantined forever without a scanner configured, which is
  // correct and means a deployment cannot demonstrate the clean/infected
  // paths without one. This is the same shape as the development identity
  // provider below: an explicit, loud, opt-in-only substitute for a real
  // integration, never a silent default. See src/patient/intake.ts for why
  // there is no default scanner otherwise.
  const devScanner = readEnv("DEV_MALWARE_SCANNER") === "on";
  if (devScanner) {
    console.warn(
      "  WARNING: NORTHSTAR_DEV_MALWARE_SCANNER=on — uploads are scanned by a synthetic " +
        "pattern match, not a real antivirus engine. Never run this in production."
    );
  }
  const engine = new Engine({
    dbPath: dbChoice.path,
    validatePack: readEnv("VALIDATE_PACK"),
    validateMode: readEnv("VALIDATE_MODE") === "annotate" ? "annotate" : "reject",
    retention: {
      redactAfterDays: days(readEnv("REDACT_AFTER_DAYS")),
      purgeAfterDays: days(readEnv("PURGE_AFTER_DAYS")),
    },
    ...(devScanner ? { malwareScanner: new SyntheticScanner() } : {}),
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

  // Laboratory dialects, before channels are seeded: a `labresults`
  // destination naming a profile that has not been registered fails every
  // delivery, and an operator should learn that from boot rather than from a
  // dead-letter queue.
  if (existsSync(LABS_DIR)) {
    for (const f of readdirSync(LABS_DIR).filter((f) => f.endsWith(".json"))) {
      const profile = JSON.parse(readFileSync(join(LABS_DIR, f), "utf8"));
      engine.registerLabProfile(profile);
      console.log(
        `laboratory profile registered: ${profile.id}` +
          (profile.timezoneOffset ? "" : " (no timezoneOffset declared; times with no zone are recorded as assumed)")
      );
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
    certPath: readEnv("TLS_CERT"),
    keyPath: readEnv("TLS_KEY"),
    caPath: readEnv("TLS_CLIENT_CA"),
    requireClientCert: readEnv("TLS_CLIENT_CA") !== undefined,
  });

  const rate = (v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`rate limit must be a positive number, got: ${v}`);
    return n;
  };

  const dev = buildDevIdp(engine, PORT);
  const api = await startApi(engine, PORT, "0.0.0.0", {
    auth: buildAuthGate(engine, dev),
    ...(dev ? { devIdp: dev.idp } : {}),
    tls: tls ?? undefined,
    rateLimit: {
      enabled: readEnv("RATE_LIMIT") !== "off",
      authenticatedPerMinute: rate(readEnv("RATE_AUTHENTICATED")),
      anonymousPerMinute: rate(readEnv("RATE_ANONYMOUS")),
    },
    remote,
  });
  console.log(
    // What is actually enforcing, not what the variable says. With the
    // development provider on, NORTHSTAR_AUTH_MODE is not what decided this,
    // and a banner reporting it would be wrong at the one moment an
    // operator reads the line.
    `Northstar listening on :${api.port} (${api.tls ? (tls?.mutual ? "mutual TLS" : "TLS") : "plain HTTP"}, ` +
      `auth ${dev ? "apikey + development identity provider" : AUTH_MODE})`
  );
  for (const ch of engine.listChannels()) {
    const port = ch.mllpPort ? ` mllp:${ch.mllpPort}` : "";
    console.log(`  channel ${ch.id} [${ch.source}]${port} ${ch.running ? "running" : "stopped"}`);
  }

  if (!api.limiter.enabled) {
    console.warn("WARNING: NORTHSTAR_RATE_LIMIT=off — a single client can saturate this node");
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
