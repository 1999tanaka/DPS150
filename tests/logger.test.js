import test from "node:test";
import assert from "node:assert/strict";

import { ExperimentLogger, recordsToCsv } from "../js/logger.js";

test("CSV contains the experiment and telemetry fields", () => {
  const csv = recordsToCsv([{
    timestamp: "2026-08-25T09:54:00.000Z",
    recordType: "measurement",
    elapsedSeconds: 0.05,
    i: 12,
    voltageMax: 14,
    currentMax: 0.1,
    controlCycleMs: 50,
    commandVoltage: 9.854,
    commandCurrent: 0.1,
    measuredVoltage: 9.79,
    measuredCurrent: 0.528,
    measuredPower: 5.169,
    measurementElapsedSeconds: 0.048,
    measurementSequence: 12,
    mode: "CV",
    protectionState: "",
    outputEnabled: true,
  }]);

  assert.match(csv, /^timestamp,record_type,elapsed_s,i,Vmax,Amax,control_cycle_ms,command_v/);
  assert.match(csv, /measurement,0\.050,12,14\.0000,0\.1000,50,9\.8540,0\.1000,9\.7900,0\.5280,5\.1690,0\.048,12,CV,OK,1/);
});

test("logger enforces its memory cap", () => {
  const logger = new ExperimentLogger({ maxRecords: 2 });
  assert.equal(logger.add({ elapsedSeconds: 0 }), true);
  assert.equal(logger.add({ elapsedSeconds: 1 }), true);
  assert.equal(logger.add({ elapsedSeconds: 2 }), false);
  assert.equal(logger.size, 2);
  assert.equal(logger.truncated, true);
});
