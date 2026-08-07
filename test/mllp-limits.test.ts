/**
 * The MLLP listener is the one surface that is deliberately unauthenticated —
 * the protocol has no credential to check — so it is also the one that has to
 * survive whatever the network hands it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { Engine } from "../src/core/engine.ts";
import { mllpSend, startMllpServer, DEFAULT_MAX_FRAME_BYTES } from "../src/hl7/mllp.ts";
import { until } from "./helpers.ts";
import type { ChannelConfig } from "../src/types.ts";

const adt =
  [
    "MSH|^~\\&|WOLF|YKPCC|PORTAGE|GNWT|20260805120000||ADT^A04^ADT_A01|LIMIT1|P|2.5.1",
    "PID|1||NT900001^^^NWT^JHN||Limit^Test||19900101|F",
    "PV1|1|O",
  ].join("\r") + "\r";

test("a frame that never terminates is cut off rather than accumulated forever", async () => {
  // Without a cap, a peer that opens a frame and never closes it grows the
  // accumulation buffer until the process dies — from an unauthenticated port.
  const received: string[] = [];
  const server = await startMllpServer(0, "127.0.0.1", async (raw) => {
    received.push(raw);
    return "ACK";
  }, 64 * 1024);

  try {
    const socket = connect(server.port, "127.0.0.1");
    await new Promise<void>((r) => socket.on("connect", () => r()));

    const closed = new Promise<void>((r) => socket.on("close", () => r()));
    socket.write(Buffer.from([0x0b])); // start of frame, and never an FS

    // Push well past the limit without ever terminating.
    const junk = Buffer.alloc(8 * 1024, 0x41);
    for (let i = 0; i < 40 && !socket.destroyed; i++) {
      socket.write(junk);
      await new Promise((r) => setTimeout(r, 5));
    }

    await Promise.race([closed, new Promise((r) => setTimeout(r, 5_000))]);
    assert.ok(socket.destroyed, "the connection must be dropped once the cap is passed");
    assert.equal(received.length, 0, "no message was ever completed");
  } finally {
    await server.close();
  }
});

test("the listener keeps working after refusing an oversized sender", async () => {
  // A refusal must cost that one connection and nothing else.
  const received: string[] = [];
  const server = await startMllpServer(0, "127.0.0.1", async (raw) => {
    received.push(raw);
    return "MSH|^~\\&|ACK\rMSA|AA|1\r";
  }, 32 * 1024);

  try {
    const bad = connect(server.port, "127.0.0.1");
    // The server drops this connection, which surfaces to the client as a
    // reset. Expected, so it must not be an unhandled error.
    bad.on("error", () => {});
    await new Promise<void>((r) => bad.on("connect", () => r()));
    bad.write(Buffer.from([0x0b]));
    bad.write(Buffer.alloc(64 * 1024, 0x42));
    await new Promise((r) => setTimeout(r, 200));

    const ack = await mllpSend("127.0.0.1", server.port, adt, 5_000);
    assert.match(ack, /MSA\|AA/, "a well-behaved sender is unaffected");
    assert.equal(received.length, 1);
  } finally {
    await server.close();
  }
});

test("a message right up to the limit still gets through", async () => {
  // The cap must not reject legitimately large messages — an ORU carrying an
  // embedded report is genuinely big.
  const limit = 512 * 1024;
  let got = "";
  const server = await startMllpServer(0, "127.0.0.1", async (raw) => {
    got = raw;
    return "MSH|^~\\&|ACK\rMSA|AA|1\r";
  }, limit);

  try {
    const filler = "X".repeat(limit - 4_096);
    const big = [
      "MSH|^~\\&|WOLF|YKPCC|PORTAGE|GNWT|20260805120000||ORU^R01|BIG1|P|2.5.1",
      `OBX|1|ST|BIG^Big result||${filler}`,
    ].join("\r") + "\r";

    const ack = await mllpSend("127.0.0.1", server.port, big, 10_000);
    assert.match(ack, /MSA\|AA/);
    assert.equal(got.length, big.length, "the whole message arrived intact");
  } finally {
    await server.close();
  }
});

test("a message split across many small packets is reassembled correctly", async () => {
  // Accumulation was rewritten to avoid concatenating on every packet, which
  // was quadratic in the packet count. Reassembly must still be exact,
  // including when the FS and its trailing CR land in different packets.
  let got = "";
  const server = await startMllpServer(0, "127.0.0.1", async (raw) => {
    got = raw;
    return "MSH|^~\\&|ACK\rMSA|AA|1\r";
  });

  try {
    const socket = connect(server.port, "127.0.0.1");
    await new Promise<void>((r) => socket.on("connect", () => r()));

    const payload = Buffer.from(adt, "utf8");
    socket.write(Buffer.from([0x0b]));
    for (let i = 0; i < payload.length; i += 7) {
      socket.write(payload.subarray(i, i + 7));
    }
    // FS and CR deliberately in separate packets, the boundary case.
    socket.write(Buffer.from([0x1c]));
    await new Promise((r) => setTimeout(r, 50));
    socket.write(Buffer.from([0x0d]));

    await until(() => got.length > 0, 5_000);
    assert.equal(got, adt, "the reassembled message must be byte-identical");
    socket.destroy();
  } finally {
    await server.close();
  }
});

test("several frames coalesced into one packet all arrive", async () => {
  const got: string[] = [];
  const server = await startMllpServer(0, "127.0.0.1", async (raw) => {
    got.push(raw);
    return "MSH|^~\\&|ACK\rMSA|AA|1\r";
  });

  try {
    const socket = connect(server.port, "127.0.0.1");
    await new Promise<void>((r) => socket.on("connect", () => r()));

    const one = Buffer.concat([Buffer.from([0x0b]), Buffer.from(adt, "utf8"), Buffer.from([0x1c, 0x0d])]);
    socket.write(Buffer.concat([one, one, one]));

    await until(() => got.length === 3, 5_000);
    assert.deepEqual(got, [adt, adt, adt]);
    socket.destroy();
  } finally {
    await server.close();
  }
});

test("hostile payloads are answered with an AE rather than taking the channel down", async () => {
  // Malformed input is a normal condition on a feed. The engine must reject
  // it per message and keep serving, not fall over.
  const engine = new Engine({ dbPath: ":memory:", tickMs: 15 });
  await engine.start();
  try {
    const channel: ChannelConfig = {
      id: "hostile",
      name: "hostile",
      source: { type: "mllp", port: 0 },
      pipeline: [{ type: "filter.hl7Type", allow: ["ADT^A04"] }],
      destinations: [{ id: "facade", type: "fhirstore", ordered: true }],
    };
    await engine.addChannel(channel);
    const port = engine.mllpPort("hostile")!;

    const hostile = [
      "",
      "not hl7 at all",
      "MSH",
      "MSH|",
      "\r\r\r",
      "MSH|^~\\&|" + "|".repeat(20_000),
      "MSH|^~\\&|X\rPID|1||" + "A^B&C~".repeat(5_000),
      "MSH.^~\\&.dots.as.separators\r",
      "MSH|^~\\&|Ünïcödé|😀|\r",
    ];

    for (const raw of hostile) {
      // Some are rejected before an ACK can be built, which closes the
      // connection; either outcome is fine, a crash is not.
      await mllpSend("127.0.0.1", port, raw, 3_000).catch(() => "");
    }

    // The channel is still up and still correct.
    const ack = await mllpSend("127.0.0.1", port, adt, 5_000);
    assert.match(ack, /MSA\|AA/, "the listener must survive everything above");
    assert.equal(engine.db.verifyChain("hostile").ok, true, "lineage is intact");
  } finally {
    await engine.stop();
  }
});

test("the default frame limit is stated and generous", () => {
  assert.equal(DEFAULT_MAX_FRAME_BYTES, 16 * 1024 * 1024);
});
