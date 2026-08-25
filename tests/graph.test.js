import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveTimeAxis, resolveWindowSeconds } from "../js/graph.js";

test("graph window stays fixed regardless of experiment period", () => {
  assert.equal(resolveWindowSeconds(1), 30);
  assert.equal(resolveWindowSeconds(5), 30);
  assert.equal(resolveWindowSeconds(10), 30);
});

test("live time axis keeps one second of space ahead of the newest sample", () => {
  const axis = resolveTimeAxis(72.4, 30);
  assert.equal(axis.xMin, 43.400000000000006);
  assert.equal(axis.xMax, 73.4);
});

test("live time axis produces one-second ticks", () => {
  const { ticks } = resolveTimeAxis(72.4, 30);
  assert.deepEqual(ticks.slice(0, 3), [44, 45, 46]);
  assert.equal(ticks.at(-1), 73);
  assert.ok(ticks.every((tick, index) => index === 0 || tick - ticks[index - 1] === 1));
});

test("measured samples are rendered as unconnected raw points", async () => {
  const source = await readFile(new URL("../js/graph.js", import.meta.url), "utf8");
  assert.match(source, /key:\s*"measuredVoltage"[\s\S]*?connectPoints:\s*false/);
  assert.match(source, /key:\s*"measuredCurrent"[\s\S]*?connectPoints:\s*false/);
});
