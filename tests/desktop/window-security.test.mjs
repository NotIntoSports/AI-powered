import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Electron window uses hardened renderer settings", async () => {
  const source = await readFile(new URL("../../desktop/main.ts", import.meta.url), "utf8");
  assert.match(source, /nodeIntegration:\s*false/);
  assert.match(source, /contextIsolation:\s*true/);
  assert.match(source, /sandbox:\s*true/);
  assert.match(source, /setWindowOpenHandler/);
  assert.match(source, /will-navigate/);
  assert.match(source, /requestSingleInstanceLock/);
});

test("preload exposes only the desktop status method", async () => {
  const source = await readFile(new URL("../../desktop/preload.ts", import.meta.url), "utf8");
  assert.match(source, /getStatus/);
  assert.doesNotMatch(source, /exec|spawn|shell|readFile|writeFile/);
});
