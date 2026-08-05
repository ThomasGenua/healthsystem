/**
 * Satellite link simulator. A TCP proxy that models the community-site tail:
 * a 500 ms geostationary hop, a jittery LEO handoff, a constrained uplink, a
 * lossy link in bad weather, or a multi-hour outage.
 *
 * Four impairments, all adjustable while running:
 *
 *   latency + jitter   a per-chunk delay in both directions
 *   bandwidth          a token-bucket uplink: bytes queue behind each other
 *                      at the configured rate, so a large message takes real
 *                      time to clear rather than arriving whole
 *   packet loss        modelled as retransmission delay, not as discarded
 *                      bytes — see below
 *   outage             existing connections cut, new ones refused
 *
 * On packet loss: this proxy must NOT drop bytes. It sits above TCP, and by
 * the time a chunk arrives here the sender has already had it acknowledged.
 * Discarding it would silently truncate the stream — something a real lossy
 * link never does, because TCP retransmits. A demo built on that would
 * "prove" store-and-forward survives data loss that cannot actually occur.
 * What an application really experiences under loss is delay: the segment is
 * retransmitted after a timeout that doubles with each successive failure.
 * That is what is simulated here, and stats().retransmits counts it.
 *
 * Delivery is kept monotonic per direction. Jitter alone could otherwise
 * schedule a later chunk ahead of an earlier one and reorder the stream,
 * which TCP also never does.
 *
 * Standalone:
 *   node demo/satlink.ts --listen 7000 --target-host 127.0.0.1 --target-port 8080 \
 *     --latency-ms 250 --jitter-ms 100 --packet-loss-pct 5 --bandwidth-kbps 256
 */
import { createServer, Socket, type Server } from "node:net";

export interface SatLinkOptions {
  listenPort: number;
  targetHost: string;
  targetPort: number;
  latencyMs?: number;
  jitterMs?: number;
  /** Chance per chunk of a retransmission, 0-100. */
  packetLossPct?: number;
  /** Link rate per direction in kilobits per second. 0 or absent is unlimited. */
  bandwidthKbps?: number;
  /** Base retransmission timeout, doubling per successive loss. */
  rtoMs?: number;
}

export interface SatLinkStats {
  connections: number;
  refused: number;
  cut: number;
  bytesForward: number;
  bytesReturn: number;
  retransmits: number;
}

export interface SatLinkHandle {
  port: number;
  setOutage(on: boolean): void;
  outage(): boolean;
  setPacketLoss(pct: number): void;
  setBandwidth(kbps: number): void;
  stats(): SatLinkStats;
  close(): Promise<void>;
}

/** Per-direction transmission state for one connection. */
interface Wire {
  /** When the link finishes serialising what is already queued. */
  queueFreeAt: number;
  /** Delivery time of the last chunk, so nothing is scheduled ahead of it. */
  lastDeliveryAt: number;
  /**
   * Serialises the writes themselves. A timestamp alone is not enough:
   * node buckets timers by duration rather than by deadline, so two chunks
   * computed to land at the same instant can still fire out of order. Chaining
   * each write onto the previous one makes the wire strictly FIFO, which is
   * what TCP guarantees and what an HL7 or HTTP body depends on.
   */
  chain: Promise<void>;
}

const newWire = (): Wire => ({ queueFreeAt: 0, lastDeliveryAt: 0, chain: Promise.resolve() });

function sleepUntil(at: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, at - Date.now()));
    t.unref?.();
  });
}

export function startSatLink(opts: SatLinkOptions): Promise<SatLinkHandle> {
  const latency = opts.latencyMs ?? 0;
  const jitter = opts.jitterMs ?? 0;
  const rto = opts.rtoMs ?? 200;
  let lossPct = opts.packetLossPct ?? 0;
  let bandwidthKbps = opts.bandwidthKbps ?? 0;
  let outage = false;
  const open = new Set<Socket>();
  const stats: SatLinkStats = {
    connections: 0,
    refused: 0,
    cut: 0,
    bytesForward: 0,
    bytesReturn: 0,
    retransmits: 0,
  };

  const jitterOf = () => (jitter > 0 ? Math.random() * jitter : 0);

  /** Milliseconds to clock `bytes` onto the wire at the configured rate. */
  const serialisationMs = (bytes: number) => (bandwidthKbps > 0 ? (bytes * 8) / bandwidthKbps : 0);

  /**
   * Extra delay from retransmission. Each successive failure doubles the
   * timeout, as TCP's exponential backoff does; capped so a pathological
   * loss setting cannot stall a demo indefinitely.
   */
  const retransmissionMs = (): number => {
    if (lossPct <= 0) return 0;
    let extra = 0;
    for (let attempt = 0; attempt < 6 && Math.random() * 100 < lossPct; attempt++) {
      extra += rto * 2 ** attempt;
      stats.retransmits++;
    }
    return extra;
  };

  /** Schedules one event on a wire, preserving order and link rate. */
  const schedule = (wire: Wire, bytes: number, fn: () => void): void => {
    const txStart = Math.max(Date.now(), wire.queueFreeAt);
    wire.queueFreeAt = txStart + serialisationMs(bytes);
    const deliverAt = Math.max(wire.queueFreeAt + latency + jitterOf() + retransmissionMs(), wire.lastDeliveryAt);
    wire.lastDeliveryAt = deliverAt;
    wire.chain = wire.chain.then(() => sleepUntil(deliverAt)).then(fn);
  };

  const relay = (from: Socket, to: Socket, direction: "forward" | "return", wire: Wire) => {
    from.on("data", (chunk: Buffer) => {
      stats[direction === "forward" ? "bytesForward" : "bytesReturn"] += chunk.length;
      schedule(wire, chunk.length, () => {
        if (!to.destroyed) to.write(chunk);
      });
    });
    from.on("end", () => {
      schedule(wire, 0, () => {
        if (!to.destroyed) to.end();
      });
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
      // Each direction gets its own wire: a busy uplink must not delay the
      // acknowledgement coming back down.
      relay(client, upstream, "forward", newWire());
      relay(upstream, client, "return", newWire());
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
        setPacketLoss(pct: number) {
          lossPct = Math.max(0, Math.min(100, pct));
        },
        setBandwidth(kbps: number) {
          bandwidthKbps = Math.max(0, kbps);
        },
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
  const packetLossPct = parseFloat(arg("packet-loss-pct", "0")!);
  const bandwidthKbps = parseInt(arg("bandwidth-kbps", "0")!, 10);
  void startSatLink({
    listenPort: listen,
    targetHost: host,
    targetPort: port,
    latencyMs,
    jitterMs,
    packetLossPct,
    bandwidthKbps,
  }).then((h) => {
    const shaped = bandwidthKbps > 0 ? `${bandwidthKbps}kbps` : "unshaped";
    console.log(
      `satlink :${h.port} -> ${host}:${port} latency ${latencyMs}ms jitter ${jitterMs}ms loss ${packetLossPct}% ${shaped}`
    );
    console.log("send SIGUSR2 to toggle outage");
    process.on("SIGUSR2", () => {
      h.setOutage(!h.outage());
      console.log(`outage: ${h.outage()}`);
    });
  });
}
