import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { ClamAvScanner } from "../src/patient/clamav.ts";
import { INTAKE_UPLOAD_MAX_BYTES } from "../src/patient/intake.ts";

async function daemon(reply: string | null) {
  const sockets = new Set<Socket>();
  let received = Buffer.alloc(0);
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", chunk => {
      if (typeof chunk === "string") chunk = Buffer.from(chunk);
      received = Buffer.concat([received, chunk]);
      if (received.length < 10) return;
      assert.equal(received.subarray(0, 10).toString(), "zINSTREAM\0");
      let offset = 10;
      while (received.length >= offset + 4) {
        const length = received.readUInt32BE(offset);
        if (length === 0) { if (reply !== null) socket.end(reply); return; }
        if (received.length < offset + 4 + length) return;
        offset += 4 + length;
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    scanner: new ClamAvScanner({ port: address.port, timeoutMs: 500 }),
    received: () => received,
    close: () => new Promise<void>(resolve => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}

test("ClamAV streams exact chunked bytes without sending the patient filename", async () => {
  const f = await daemon("stream: OK\0");
  try {
    const data = Buffer.alloc(150_000, 42);
    assert.equal((await f.scanner.scan(data, "private-patient-name.pdf")).verdict, "clean");
    const wire = f.received();
    const chunks: Buffer[] = [];
    let offset = 10;
    while (wire.readUInt32BE(offset)) {
      const length = wire.readUInt32BE(offset); offset += 4;
      assert.ok(length <= 65536);
      chunks.push(wire.subarray(offset, offset + length)); offset += length;
    }
    assert.equal(offset + 4, wire.length);
    assert.deepEqual(Buffer.concat(chunks), data);
    assert.equal(wire.includes("private-patient-name"), false);
  } finally { await f.close(); }
});

test("ClamAV reports infected content without persisting untrusted daemon text", async () => {
  const f = await daemon("stream: Eicar-Signature FOUND\0");
  try { assert.deepEqual(await f.scanner.scan(Buffer.from("fixture"), "x"), { verdict: "infected", note: "ClamAV INSTREAM: malware detected" }); }
  finally { await f.close(); }
});

for (const reply of ["", "stream: OK", "stream: OK\0stream: Malware FOUND\0", "INSTREAM size limit exceeded. ERROR\0", "stream: ERROR\0", "x".repeat(9000), null]) {
  test(`ClamAV fails closed on ${reply === null ? "timeout" : JSON.stringify(reply.slice(0, 60))}`, async () => {
    const f = await daemon(reply);
    try { await assert.rejects(f.scanner.scan(Buffer.from("fixture"), "x"), /quarantined/); }
    finally { await f.close(); }
  });
}

test("ClamAV rejects invalid configuration and oversize input", async () => {
  for (const config of [{}, { port: 0 }, { port: 65536 }, { port: 3.5 }, { socketPath: "relative" }, { socketPath: "\\\\remote\\pipe\\clamd" }, { socketPath: "//remote/socket" }, { port: 3310, socketPath: "/socket" }]) {
    assert.throws(() => new ClamAvScanner(config));
  }
  await assert.rejects(new ClamAvScanner({ port: 3310 }).scan(Buffer.alloc(INTAKE_UPLOAD_MAX_BYTES + 1), "x"), /size limit/);
});
