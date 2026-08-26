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

test("includes the browser Python editor and a same-origin module worker policy", () => {
  assert.match(html, /id="python-code"/);
  assert.match(html, /id="check-python"/);
  assert.match(html, /id="preview-python"/);
  assert.match(html, /id="preview-dialog"/);
  assert.match(html, /worker-src 'self'/);
  assert.match(html, /script-src 'self' 'wasm-unsafe-eval'/);
});

test("labels waveform preview as a no-output operation", () => {
  assert.match(html, /DPS-150へコマンドを送信せず/);
  assert.match(html, /Preview only · No serial command sent/);
});

test("allows current UI elements to be absent in a cached older document", () => {
  assert.match(main, /elements\.currentGraphCanvas\s*\?\s*new CurrentGraph/);
  assert.match(main, /currentGraph\?\.addPoint/);
  assert.match(main, /if \(elements\.commandCurrent\)/);
});
