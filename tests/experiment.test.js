import test from "node:test";
import assert from "node:assert/strict";

import { ExperimentController } from "../js/experiment.js";
import { ExperimentLogger } from "../js/logger.js";

if (typeof globalThis.CustomEvent === "undefined") {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, options = {}) {
      super(type);
      this.detail = options.detail;
    }
  };
}

class FakeDevice extends EventTarget {
  constructor() {
    super();
    this.connected = true;
    this.outputEnabled = false;
    this.voltages = [];
    this.current = null;
    this.offCalls = 0;
    this.measurementRequests = 0;
    this.measurementSequence = 0;
    this.measurementReceivedAtMs = null;
  }

  async setCurrent(value) {
    this.current = value;
  }

  async setVoltage(value) {
    this.voltages.push(value);
  }

  async outputOn() {
    this.outputEnabled = true;
  }

  async outputOff() {
    this.outputEnabled = false;
    this.offCalls += 1;
  }

  async requestMeasurements() {
    this.measurementRequests += 1;
    this.measurementSequence += 1;
    this.measurementReceivedAtMs = performance.now();
    const state = this.getState();
    this.dispatchEvent(new CustomEvent("telemetry", {
      detail: {
        state,
        update: {
          measuredVoltage: state.measuredVoltage,
          measuredCurrent: state.measuredCurrent,
          measuredPower: state.measuredPower,
        },
        register: 0xc3,
      },
    }));
  }

  getState() {
    return {
      telemetryAgeMs: 0,
      measurementAgeMs: 0,
      measurementSequence: this.measurementSequence,
      measurementReceivedAtMs: this.measurementReceivedAtMs,
      measuredVoltage: this.voltages.at(-1) ?? 0,
      measuredCurrent: 0.5,
      measuredPower: 4,
      mode: "CV",
      protectionState: "",
      outputEnabled: this.outputEnabled,
    };
  }
}

function shortConfig(duration = 0.04) {
  return {
    currentLimit: 1,
    baseVoltage: 7,
    aValues: [2],
    periods: [duration],
    cycles: 1,
    updateInterval: 5,
    totalDuration: duration,
    deviceMaxVoltage: 24,
  };
}

test("short experiment sets current, runs waveform, and turns output off", async () => {
  const device = new FakeDevice();
  const logger = new ExperimentLogger();
  const controller = new ExperimentController(device, logger);
  const result = await controller.start(shortConfig());

  assert.equal(result.status, "completed");
  assert.equal(device.current, 1);
  assert.ok(device.voltages.length >= 2);
  assert.equal(device.outputEnabled, false);
  assert.ok(device.offCalls >= 1);
  assert.ok(logger.size >= 1);
});

test("editable Formula Base B is used by the device voltage commands", async () => {
  const device = new FakeDevice();
  const controller = new ExperimentController(device, new ExperimentLogger());
  const result = await controller.start({ ...shortConfig(), baseVoltage: 6 });

  assert.equal(result.status, "completed");
  assert.equal(device.voltages[0], 7);
  assert.ok(device.voltages.every((voltage) => voltage >= 2 && voltage <= 12));
});

test("STOP interrupts the timer and leaves output off", async () => {
  const device = new FakeDevice();
  const controller = new ExperimentController(device, new ExperimentLogger());
  const run = controller.start(shortConfig(0.5));
  setTimeout(() => void controller.stop(), 25);
  const result = await run;

  assert.equal(result.status, "stopped");
  assert.equal(device.outputEnabled, false);
  assert.ok(device.offCalls >= 1);
});

test("high-speed polling records individual raw measurement events", async () => {
  const device = new FakeDevice();
  const logger = new ExperimentLogger();
  const controller = new ExperimentController(device, logger);
  await controller.start(shortConfig(0.18));

  assert.ok(device.measurementRequests >= 2);
  const measurements = logger.records.filter((record) => record.recordType === "measurement");
  assert.equal(measurements.length, device.measurementRequests);
  assert.ok(measurements.every((record) => Number.isFinite(record.measurementElapsedSeconds)));
});
