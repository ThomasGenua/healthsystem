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
import { CharsetError, DEFAULT_CHARSET, decodeFrame, encodeFrame } from "./charset.ts";

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;

/**
 * Largest frame accepted, in bytes. Generous next to real HL7 v2 — an ORU
 * carrying an embedded report is a few hundred kilobytes at most — while
 * still bounding what one socket can make the process hold.
 */
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function frame(payload: string, charset: string = DEFAULT_CHARSET): Buffer {
  return Buffer.concat([Buffer.from([VT]), encodeFrame(payload, charset), Buffer.from([FS, CR])]);
}

/**
 * Extract complete frames from a buffer.
 *
 * Frames come back as bytes, not text. MLLP is a byte transport and the
 * character set is declared inside the message it carries, so decoding here
 * would mean guessing — and guessing UTF-8 is what silently replaced every
 * accented character in an ISO-8859-1 message with U+FFFD. The decision belongs
 * one layer up, where MSH-18 and the channel's configuration can be consulted.
 */
export function deframe(buf: Buffer): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = [];
  let cursor = 0;
  for (;;) {
    const start = buf.indexOf(VT, cursor);
    if (start === -1) break;
    const end = buf.indexOf(FS, start + 1);
    if (end === -1) break;
    // Tolerate a missing trailing CR from lax senders.
    const next = buf[end + 1] === CR ? end + 2 : end + 1;
    frames.push(buf.subarray(start + 1, end));
    cursor = next;
  }
  return { frames, rest: buf.subarray(cursor) };
}

/**
 * A NAK for a frame that could not be decoded.
 *
 * MSH is ASCII by construction — delimiters, field names and every Table 0211
 * value — so a byte-preserving latin1 read of it yields the sending
 * application and the message control id correctly even when the rest of the
 * frame is in a character set we could not read. That is exactly what the
 * sender needs to match the rejection to the message it sent.
 */
function nakFor(bytes: Buffer, reason: string): string {
  const crAt = bytes.indexOf(CR);
  const msh = bytes.subarray(0, crAt === -1 ? bytes.length : crAt).toString("latin1");
  const fields = msh.split(msh[3] ?? "|");
  const controlId = fields[9] ?? "";
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return (
    [
      `MSH|^~\\&|PORTAGE|GNWT|${fields[2] ?? ""}|${fields[3] ?? ""}|${stamp}||ACK|${controlId}|P|2.5.1|||||||${DEFAULT_CHARSET}`,
      `MSA|AR|${controlId}|${reason.replace(/[|^~\\&\r\n]/g, " ").slice(0, 180)}`,
    ].join("\r") + "\r"
  );
}

export interface MllpServerHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export interface MllpServerOptions {
  maxFrameBytes?: number;
  /**
   * Character set to assume when the sender declares none in MSH-18, which is
   * most senders. Defaults to UTF-8, so an existing deployment is unaffected;
   * a feed that speaks ISO-8859-1 without saying so is configured here.
   */
  charset?: string;
}

export function startMllpServer(
  port: number,
  host: string,
  onMessage: (raw: string) => Promise<string>,
  opts: MllpServerOptions = {}
): Promise<MllpServerHandle> {
  const maxFrameBytes = opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const configuredCharset = opts.charset ?? DEFAULT_CHARSET;
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

        for (const bytes of frames) {
          let decoded: { text: string; charset: string };
          try {
            decoded = decodeFrame(bytes, configuredCharset);
          } catch (err) {
            if (!(err instanceof CharsetError)) throw err;
            // Refused, and the sender is told which message and why. Storing
            // it with replacement characters would hand a clinician a name
            // that is not the patient's, under an AA saying it was received
            // correctly. A NAK is recoverable; that is not.
            const why = err.message;
            console.error(`mllp: ${why} from ${socket.remoteAddress ?? "unknown"}`);
            if (!socket.destroyed) socket.write(frame(nakFor(bytes, why), DEFAULT_CHARSET));
            continue;
          }
          onMessage(decoded.text)
            .then((ack) => {
              // Answered in the character set the sender used, so an accented
              // name echoed back in the ACK is the one they sent.
              if (!socket.destroyed) socket.write(frame(ack, decoded.charset));
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
export function mllpSend(
  host: string,
  port: number,
  payload: string,
  timeoutMs = 10_000,
  charset: string = DEFAULT_CHARSET
): Promise<string> {
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
        // The remote answers in whatever it answers in; MSH-18 on the ACK is
        // what says which. A NAK that cannot be decoded is still worth
        // surfacing, so that falls back to a byte-preserving read rather than
        // becoming a timeout.
        try {
          finish(null, decodeFrame(frames[0], charset).text);
        } catch {
          finish(null, frames[0].toString("latin1"));
        }
      }
    });
    socket.connect(port, host, () => {
      try {
        socket.write(frame(payload, charset));
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}
