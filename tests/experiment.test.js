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
    this.currents = [];
    this.offCalls = 0;
    this.measurementRequests = 0;
    this.measurementSequence = 0;
    this.measurementReceivedAtMs = null;
  }

  async setCurrent(value) {
    this.currents.push(value);
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
      setVoltage: this.voltages.at(-1) ?? 0,
      measuredVoltage: this.voltages.at(-1) ?? 0,
      measuredCurrent: this.currents.at(-1) ?? 0,
      measuredPower: 4,
      mode: "CV",
      protectionState: "",
      outputEnabled: this.outputEnabled,
    };
  }
}

class FakePythonControl {
  constructor({ stopAt = 4, command = null } = {}) {
    this.stopAt = stopAt;
    this.command = command;
    this.calls = [];
    this.i = 0;
  }

  async prepare(source) {
    this.calls.push(["prepare", source]);
    return { version: "test" };
  }

  async begin(context) {
    this.calls.push(["begin", context]);
    this.i = 0;
    return { started: true };
  }

  async evaluate(limits) {
    const i = this.i;
    this.calls.push(["evaluate", { i }, limits]);
    if (i >= this.stopAt) return { done: true };
    this.i += 1;
    if (this.command) return this.command({ i }, limits);
    return { done: false, current: 0.1, voltage: 13 + i * 0.01 };
  }

  terminate() {
    this.calls.push(["terminate"]);
  }
}

function shortConfig(overrides = {}) {
  return {
    voltageMax: 14,
    currentMax: 0.2,
    controlCycleMs: 10,
    deviceMaxVoltage: 24,
    deviceMaxCurrent: 5,
    pythonSource: "def control(Vmax, Amax):\n    yield Amax, Vmax",
    ...overrides,
  };
}

test("Python generator controls A and V for each i, then completion turns output off", async () => {
  const device = new FakeDevice();
  const logger = new ExperimentLogger();
  const python = new FakePythonControl({ stopAt: 4 });
  const controller = new ExperimentController(device, logger, python);
  const commandTimes = [];
  controller.addEventListener("progress", (event) => commandTimes.push(event.detail.elapsedSeconds));
  const result = await controller.start(shortConfig());

  assert.equal(result.status, "completed");
  assert.equal(result.iterations, 4);
  assert.deepEqual(
    python.calls.filter(([name]) => name === "evaluate").map(([, context]) => context.i),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(
    python.calls.find(([name]) => name === "begin")?.[1],
    { Vmax: 14, Amax: 0.2 },
  );
  assert.deepEqual(device.voltages, [13, 13.01, 13.02, 13.03]);
  assert.ok(commandTimes.slice(1).every((time, index) => time - commandTimes[index] >= 0.004));
  assert.equal(device.currents.at(-1), 0.1);
  assert.equal(device.outputEnabled, false);
  assert.ok(device.offCalls >= 1);
  assert.ok(logger.size >= 4);
});

test("STOP interrupts a run and leaves output off", async () => {
  const device = new FakeDevice();
  const python = new FakePythonControl({ stopAt: Number.POSITIVE_INFINITY });
  const controller = new ExperimentController(device, new ExperimentLogger(), python);
  const run = controller.start(shortConfig());
  setTimeout(() => void controller.stop(), 25);
  const result = await run;

  assert.equal(result.status, "stopped");
  assert.equal(device.outputEnabled, false);
  assert.ok(device.offCalls >= 1);
  assert.ok(python.calls.some(([name]) => name === "terminate"));
});

test("high-speed polling records individual raw measurement events", async () => {
  const device = new FakeDevice();
  const logger = new ExperimentLogger();
  const python = new FakePythonControl({ stopAt: 10 });
  const controller = new ExperimentController(device, logger, python);
  await controller.start(shortConfig());

  assert.ok(device.measurementRequests >= 1);
  const measurements = logger.records.filter((record) => record.recordType === "measurement");
  assert.equal(measurements.length, device.measurementRequests);
  assert.ok(measurements.every((record) => Number.isFinite(record.measurementElapsedSeconds)));
});

test("commands outside Vmax/Amax are rejected before being sent", async () => {
  const device = new FakeDevice();
  const python = new FakePythonControl({
    command: () => ({ done: false, current: 0.1, voltage: 14.1 }),
  });
  const controller = new ExperimentController(device, new ExperimentLogger(), python);

  await assert.rejects(() => controller.start(shortConfig()), /Vmax/);
  assert.deepEqual(device.voltages, []);
  assert.equal(device.outputEnabled, false);
  assert.ok(device.offCalls >= 1);
});
