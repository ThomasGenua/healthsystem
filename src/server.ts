/** Portage entry point. */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "./core/engine.ts";
import { startApi } from "./api/admin.ts";
import type { ChannelConfig, MappingDoc } from "./types.ts";

const PORT = parseInt(process.env.PORTAGE_PORT ?? "8686", 10);
const DATA_DIR = process.env.PORTAGE_DATA ?? join(process.cwd(), "data");
const CHANNELS_DIR = process.env.PORTAGE_CHANNELS ?? join(process.cwd(), "channels");
const MAPPINGS_DIR = process.env.PORTAGE_MAPPINGS ?? join(process.cwd(), "mappings");
const TERMINOLOGY_DIR = process.env.PORTAGE_TERMINOLOGY ?? join(process.cwd(), "terminology");
const CONFORMANCE_DIR = process.env.PORTAGE_CONFORMANCE ?? join(process.cwd(), "conformance");

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

  const api = await startApi(engine, PORT);
  console.log(`Portage listening on :${api.port}`);
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
