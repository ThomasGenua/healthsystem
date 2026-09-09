import { createConnection } from "node:net";
import { isAbsolute } from "node:path";
import { INTAKE_UPLOAD_MAX_BYTES, type MalwareScanner, type ScanVerdict } from "./intake.ts";

/** clamd INSTREAM, confined to this host: the protocol has no authentication/TLS. */
export class ClamAvScanner implements MalwareScanner {
  private readonly options: { socketPath?: string; port?: number; timeoutMs?: number };
  constructor(options: { socketPath?: string; port?: number; timeoutMs?: number }) {
    if (Boolean(options.socketPath) === (options.port !== undefined) ||
        (options.socketPath !== undefined && (!isAbsolute(options.socketPath) || options.socketPath.includes("\0") ||
          options.socketPath.startsWith("\\\\") || options.socketPath.startsWith("//"))) ||
        (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) ||
        (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1))) {
      throw new Error("Configure one absolute local clamd socket path or a loopback TCP port (1–65535)");
    }
    this.options = { ...options };
  }

  async scan(bytes: Buffer, _filename: string): Promise<ScanVerdict> {
    if (bytes.length > INTAKE_UPLOAD_MAX_BYTES) throw new Error("Upload exceeds scanner size limit");
    const data = Buffer.from(bytes);
    return new Promise((resolve, reject) => {
      const socket = this.options.socketPath
        ? createConnection({ path: this.options.socketPath })
        : createConnection({ host: "127.0.0.1", port: this.options.port! });
      let reply = Buffer.alloc(0);
      let finished = false;
      const finish = (error?: Error, verdict?: ScanVerdict) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error); else resolve(verdict!);
      };
      const timer = setTimeout(() => finish(new Error("Malware scanner timed out; upload remains quarantined")), this.options.timeoutMs ?? 30_000);
      socket.on("error", () => finish(new Error("Malware scanner unavailable; upload remains quarantined")));
      socket.on("connect", () => {
        socket.write("zINSTREAM\0");
        // At most 8 MiB buffered per scan, matching the upload limit. No filename is sent.
        for (let offset = 0; offset < data.length; offset += 64 * 1024) {
          const chunk = data.subarray(offset, offset + 64 * 1024);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length);
          socket.write(size);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      });
      socket.on("data", chunk => {
        if (typeof chunk === "string") chunk = Buffer.from(chunk);
        if (reply.length + chunk.length > 8192) {
          finish(new Error("Invalid malware scanner response; upload remains quarantined"));
        } else reply = Buffer.concat([reply, chunk]);
      });
      socket.on("end", () => {
        // Require exactly one complete response; partial, error and mixed replies fail closed.
        const result = reply.toString("utf8");
        if (result === "stream: OK\0") finish(undefined, { verdict: "clean", note: "ClamAV INSTREAM: clean" });
        else if (/^stream: [^\x00-\x1f\x7f]+ FOUND\0$/.test(result)) {
          finish(undefined, { verdict: "infected", note: "ClamAV INSTREAM: malware detected" });
        } else finish(new Error("Invalid malware scanner response; upload remains quarantined"));
      });
      socket.on("close", () => {
        if (!finished) finish(new Error("Malware scanner disconnected; upload remains quarantined"));
      });
    });
  }
}
