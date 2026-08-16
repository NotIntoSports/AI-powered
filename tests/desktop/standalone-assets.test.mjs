import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
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
  assert.match(script, /standaloneRoot,\s*["']server\.js["']/);
  assert.doesNotMatch(script, /findServer/);
});

test("electron-builder preserves traced node_modules in extra resources", async () => {
  const config = await readFile(new URL("../../electron-builder.yml", import.meta.url), "utf8");
  assert.match(config, /from:\s*\.desktop-runtime\/node_modules/);
  assert.match(config, /to:\s*\.desktop-runtime\/node_modules/);
});

test("built desktop runtime contains the traced Next server dependencies", async (t) => {
  const root = new URL("../../.desktop-runtime/", import.meta.url);
  try {
    await access(new URL("server.js", root));
  } catch {
    t.skip("requires a local standalone desktop runtime");
    return;
  }
  await Promise.all([
    access(new URL("node_modules/next/package.json", root)),
    access(new URL("node_modules/next/dist/compiled/@mswjs/interceptors/ClientRequest/index.js", root))
  ]);
});
