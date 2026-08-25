import test from "node:test";
import assert from "node:assert/strict";

import {
  PacketParser,
  buildPacket,
  calculateChecksum,
  encodeFloat32,
} from "../js/dps150.js";

test("builds the documented 12.3 V set packet", () => {
  const packet = buildPacket(0xb1, 0xc1, encodeFloat32(12.3));
  assert.deepEqual(
    [...packet],
    [0xf1, 0xb1, 0xc1, 0x04, 0xcd, 0xcc, 0x44, 0x41, 0xe3],
  );
});

test("checksum excludes header and command bytes", () => {
  assert.equal(calculateChecksum(0xdb, [1]), 0xdd);
  assert.equal(calculateChecksum(0xdb, [0]), 0xdc);
});

test("parser reconstructs a response split across chunks", () => {
  const response = buildPacket(0xa1, 0xc1, encodeFloat32(12.3), 0xf0);
  const parser = new PacketParser();
  assert.deepEqual(parser.push(response.slice(0, 3)), []);
  const frames = parser.push(response.slice(3));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].register, 0xc1);
  assert.deepEqual([...frames[0].data], [0xcd, 0xcc, 0x44, 0x41]);
});

test("parser skips noise and recovers after a bad checksum", () => {
  const bad = buildPacket(0xa1, 0xdb, [1], 0xf0);
  bad[bad.length - 1] ^= 0xff;
  const good = buildPacket(0xa1, 0xdb, [0], 0xf0);
  const combined = Uint8Array.from([0x11, 0x22, ...bad, ...good]);
  const parser = new PacketParser();
  const frames = parser.push(combined);
  assert.equal(parser.checksumErrors, 1);
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0].data], [0]);
});
