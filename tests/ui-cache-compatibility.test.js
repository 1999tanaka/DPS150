import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, main] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../js/main.js", import.meta.url), "utf8"),
]);

test("keeps the original voltage graph window id for cached JavaScript", () => {
  assert.match(html, /id="graph-window"/);
});

test("loads the entry module with a cache-busting version", () => {
  assert.match(html, /src="js\/main\.js\?v=[^"]+"/);
});

test("exposes Maximum Voltage B and substitutes B/2 for both former 7 constants", () => {
  assert.match(html, /id="base-voltage"[^>]*value="14\.0"/);
  assert.match(html, /V\(t\) = \(B\/2 \+ A\/2\) \+ \(B\/2 − A\/2\)/);
  assert.match(main, /maximumVoltageB: elements\.maximumVoltageB\.value/);
});

test("allows current UI elements to be absent in a cached older document", () => {
  assert.match(main, /elements\.currentGraphCanvas\s*\?\s*new CurrentGraph/);
  assert.match(main, /currentGraph\?\.addPoint/);
  assert.match(main, /if \(elements\.commandCurrent\)/);
});
