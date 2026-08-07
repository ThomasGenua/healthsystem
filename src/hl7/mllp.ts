/**
 * MLLP transport: <VT> payload <FS><CR>.
 * The server accumulates per socket, handles partial and coalesced frames,
 * and writes back whatever ACK the handler returns. The client sends one
 * framed message and resolves on the first complete ACK frame.
 *
 * This is the one listener that is deliberately unauthenticated — MLLP has no
 * credential to check — so it is also the one that must not fall over when
 * handed something hostile. A frame is only complete at <FS>, so a peer that
 * never sends one could otherwise grow the accumulation buffer without limit
 * until the process died. Frames are capped, and a sender that exceeds the
 * cap has its connection dropped.
 */
import { createServer, Socket, type Server } from "node:net";

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;

/**
 * Largest frame accepted, in bytes. Generous next to real HL7 v2 — an ORU
 * carrying an embedded report is a few hundred kilobytes at most — while
 * still bounding what one socket can make the process hold.
 */
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

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
  onMessage: (raw: string) => Promise<string>,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES
): Promise<MllpServerHandle> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket: Socket) => {
      // Chunks are held in a list and joined only when a frame could actually
      // be complete. Concatenating on every packet made accumulation
      // quadratic in the number of packets, which a slow drip sender could
      // exploit even within the size cap.
      let chunks: Buffer[] = [];
      let pending = 0;
      let mightComplete = false;

      socket.on("data", (chunk: Buffer) => {
        if (pending + chunk.length > maxFrameBytes) {
          // No usable NAK is possible: without a terminator there is no
          // message to acknowledge, and the sender is past what will ever be
          // accepted. Drop the connection.
          console.error(`mllp: frame exceeded ${maxFrameBytes} bytes from ${socket.remoteAddress ?? "unknown"}`);
          socket.destroy();
          return;
        }
        chunks.push(chunk);
        pending += chunk.length;

        // A frame ends at FS. If neither this chunk nor what is already held
        // contains one, no frame can be complete yet.
        if (!mightComplete && !chunk.includes(FS)) return;

        const buffer = Buffer.concat(chunks);
        const { frames, rest } = deframe(buffer);
        chunks = rest.length > 0 ? [rest] : [];
        pending = rest.length;
        // An FS left in the remainder means a frame is complete but for its
        // trailing CR, so the next chunk must trigger another attempt.
        mightComplete = rest.includes(FS);

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
      // The far end is no more trusted than a sender is: a remote that never
      // terminates its ACK must not be able to grow this without limit.
      if (buffer.length + chunk.length > DEFAULT_MAX_FRAME_BYTES) {
        finish(new Error(`MLLP ACK exceeded ${DEFAULT_MAX_FRAME_BYTES} bytes`));
        return;
      }
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
