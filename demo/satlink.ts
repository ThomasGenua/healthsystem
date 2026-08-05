/**
 * Satellite link simulator. A TCP proxy that adds base latency plus jitter to
 * every chunk in both directions, and can be flipped into an outage: existing
 * connections are cut and new ones refused until the link is restored. This
 * stands in for the community-site tail: a 500 ms geostationary hop, a jittery
 * LEO handoff, or a multi-hour weather outage.
 *
 * Standalone:
 *   node demo/satlink.ts --listen 7000 --target-host 127.0.0.1 --target-port 8080 --latency-ms 250 --jitter-ms 100
 */
import { createServer, Socket, type Server } from "node:net";

export interface SatLinkOptions {
  listenPort: number;
  targetHost: string;
  targetPort: number;
  latencyMs?: number;
  jitterMs?: number;
}

export interface SatLinkHandle {
  port: number;
  setOutage(on: boolean): void;
  outage(): boolean;
  stats(): { connections: number; refused: number; cut: number; bytesForward: number; bytesReturn: number };
  close(): Promise<void>;
}

export function startSatLink(opts: SatLinkOptions): Promise<SatLinkHandle> {
  const latency = opts.latencyMs ?? 0;
  const jitter = opts.jitterMs ?? 0;
  let outage = false;
  const open = new Set<Socket>();
  const stats = { connections: 0, refused: 0, cut: 0, bytesForward: 0, bytesReturn: 0 };

  const delay = () => latency + (jitter > 0 ? Math.random() * jitter : 0);

  const relay = (from: Socket, to: Socket, direction: "forward" | "return") => {
    from.on("data", (chunk: Buffer) => {
      stats[direction === "forward" ? "bytesForward" : "bytesReturn"] += chunk.length;
      const t = setTimeout(() => {
        if (!to.destroyed) to.write(chunk);
      }, delay());
      t.unref?.();
    });
    from.on("end", () => {
      const t = setTimeout(() => {
        if (!to.destroyed) to.end();
      }, delay());
      t.unref?.();
    });
    from.on("error", () => to.destroy());
  };

  const server: Server = createServer((client) => {
    if (outage) {
      stats.refused++;
      client.destroy();
      return;
    }
    stats.connections++;
    const upstream = new Socket();
    open.add(client);
    open.add(upstream);
    const drop = () => {
      open.delete(client);
      open.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    upstream.on("error", drop);
    client.on("error", drop);
    client.on("close", () => drop());
    upstream.on("close", () => drop());
    upstream.connect(opts.targetPort, opts.targetHost, () => {
      relay(client, upstream, "forward");
      relay(upstream, client, "return");
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.listenPort, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.listenPort;
      resolve({
        port,
        setOutage(on: boolean) {
          if (on && !outage) {
            for (const s of open) {
              stats.cut++;
              s.destroy();
            }
            open.clear();
          }
          outage = on;
        },
        outage: () => outage,
        stats: () => ({ ...stats }),
        close: () =>
          new Promise<void>((r) => {
            for (const s of open) s.destroy();
            open.clear();
            server.close(() => r());
          }),
      });
    });
  });
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  const listen = parseInt(arg("listen", "7000")!, 10);
  const host = arg("target-host", "127.0.0.1")!;
  const port = parseInt(arg("target-port", "8080")!, 10);
  const latencyMs = parseInt(arg("latency-ms", "250")!, 10);
  const jitterMs = parseInt(arg("jitter-ms", "100")!, 10);
  void startSatLink({ listenPort: listen, targetHost: host, targetPort: port, latencyMs, jitterMs }).then((h) => {
    console.log(`satlink :${h.port} -> ${host}:${port} latency ${latencyMs}ms jitter ${jitterMs}ms`);
    console.log("send SIGUSR2 to toggle outage");
    process.on("SIGUSR2", () => {
      h.setOutage(!h.outage());
      console.log(`outage: ${h.outage()}`);
    });
  });
}
