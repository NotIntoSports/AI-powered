import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Next config enables standalone output", async () => {
  const config = await readFile(new URL("../../next.config.mjs", import.meta.url), "utf8");
  assert.match(config, /output:\s*["']standalone["']/);
  assert.match(config, /outputFileTracingRoot/);
});

test("desktop runtime script copies server, static assets, and public files", async () => {
  const script = await readFile(
    new URL("../../scripts/build-next-standalone.mjs", import.meta.url),
    "utf8"
  );
  assert.match(script, /\.next["'],\s*["']standalone/);
  assert.match(script, /\.next["'],\s*["']static/);
  assert.match(script, /["']public["']/);
  assert.match(script, /\.desktop-runtime/);
  assert.match(script, /server\.js/);
});
