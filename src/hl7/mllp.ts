/**
 * MLLP transport: <VT> payload <FS><CR>.
 * The server accumulates per socket, handles partial and coalesced frames,
 * and writes back whatever ACK the handler returns. The client sends one
 * framed message and resolves on the first complete ACK frame.
 */
import { createServer, Socket, type Server } from "node:net";

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;

export function frame(payload: string): Buffer {
  return Buffer.concat([Buffer.from([VT]), Buffer.from(payload, "utf8"), Buffer.from([FS, CR])]);
}

/** Extract complete frames from a buffer. Returns frames and the remainder. */
export function deframe(buf: Buffer): { frames: string[]; rest: Buffer } {
  const frames: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = buf.indexOf(VT, cursor);
    if (start === -1) break;
    const end = buf.indexOf(FS, start + 1);
    if (end === -1 || end + 1 >= buf.length + 1) {
      if (end === -1) break;
    }
    if (end === -1) break;
    // Tolerate a missing trailing CR from lax senders.
    const next = buf[end + 1] === CR ? end + 2 : end + 1;
    frames.push(buf.subarray(start + 1, end).toString("utf8"));
    cursor = next;
  }
  return { frames, rest: buf.subarray(cursor) };
}

export interface MllpServerHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export function startMllpServer(
  port: number,
  host: string,
  onMessage: (raw: string) => Promise<string>
): Promise<MllpServerHandle> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket: Socket) => {
      let buffer: Buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const { frames, rest } = deframe(buffer);
        buffer = rest;
        for (const raw of frames) {
          onMessage(raw)
            .then((ack) => {
              if (!socket.destroyed) socket.write(frame(ack));
            })
            .catch(() => {
              if (!socket.destroyed) socket.destroy();
            });
        }
      });
      socket.on("error", () => socket.destroy());
    });
    server.on("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        server,
        port: actual,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

/** Send one message and wait for the ACK payload. */
export function mllpSend(host: string, port: number, payload: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let buffer: Buffer = Buffer.alloc(0);
    let done = false;
    const finish = (err: Error | null, ack?: string) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(ack ?? "");
    };
    const timer = setTimeout(() => finish(new Error(`MLLP timeout after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    socket.on("error", (e) => finish(e));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames } = deframe(buffer);
      if (frames.length > 0) {
        clearTimeout(timer);
        finish(null, frames[0]);
      }
    });
    socket.connect(port, host, () => {
      socket.write(frame(payload));
    });
  });
}
