import test from "node:test";
import assert from "node:assert/strict";

import {
  DPS150,
  PacketParser,
  REGISTER,
  buildPacket,
  calculateChecksum,
  encodeFloat32,
} from "../js/dps150.js";

if (typeof globalThis.CustomEvent === "undefined") {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, options = {}) {
      super(type);
      this.detail = options.detail;
    }
  };
}

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

test("builds the documented OUTPUT ON packet", () => {
  assert.deepEqual(
    [...buildPacket(0xb1, REGISTER.OUTPUT_ENABLE, [1])],
    [0xf1, 0xb1, 0xdb, 0x01, 0x01, 0xdd],
  );
});

test("OUTPUT ON is accepted only after the device confirms register 0xDB", async () => {
  const dps = new DPS150({ outputConfirmTimeoutMs: 25, commandSettleMs: 1 });
  const sent = [];
  dps.sendCommand = async (command, register, data) => {
    sent.push({ command, register, data });
    if (command === 0xb1 && register === REGISTER.OUTPUT_ENABLE) {
      setTimeout(() => {
        dps.handleFrame({ command: 0xa1, register, data: Uint8Array.of(data) });
      }, 1);
    }
  };

  await dps.outputOn();
  assert.equal(dps.getState().outputEnabled, true);
  assert.equal(sent[0].register, REGISTER.OUTPUT_ENABLE);
  assert.equal(sent[0].data, 1);
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

test("measurement frames advance a dedicated raw-sample sequence", () => {
  const payload = new Uint8Array(12);
  const view = new DataView(payload.buffer);
  view.setFloat32(0, 13.25, true);
  view.setFloat32(4, 0.1, true);
  view.setFloat32(8, 1.325, true);

  const dps = new DPS150();
  dps.handleFrame({ command: 0xa1, register: REGISTER.MEASUREMENT, data: payload });
  const first = dps.getState();
  dps.handleFrame({ command: 0xa1, register: REGISTER.MEASUREMENT, data: payload });
  const second = dps.getState();

  assert.equal(first.measurementSequence, 1);
  assert.equal(second.measurementSequence, 2);
  assert.equal(second.measuredVoltage, 13.25);
  assert.ok(Number.isFinite(second.measurementAgeMs));
});
