import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPreviewStepPoints,
  resolvePreviewYDomain,
} from "../js/preview-graph.js";

test("preview graph pads a changing waveform domain", () => {
  const domain = resolvePreviewYDomain([13, 14]);
  assert.ok(domain.min < 13);
  assert.ok(domain.max > 14);
  assert.ok(domain.min >= 0);
});

test("preview graph gives a constant waveform visible vertical space", () => {
  const domain = resolvePreviewYDomain([13.5, 13.5]);
  assert.ok(domain.min < 13.5);
  assert.ok(domain.max > 13.5);
});

test("preview graph falls back safely for empty data", () => {
  assert.deepEqual(resolvePreviewYDomain([]), { min: 0, max: 1 });
});

test("preview graph holds each command until the next control cycle", () => {
  const path = buildPreviewStepPoints([
    { time: 0, commandVoltage: 13 },
    { time: 0.05, commandVoltage: 14 },
  ], 0.1, "commandVoltage");

  assert.deepEqual(path, [
    { time: 0, value: 13 },
    { time: 0.05, value: 13 },
    { time: 0.05, value: 14 },
    { time: 0.1, value: 14 },
  ]);
});
