import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("parallel Tauri shell preserves legacy entry points", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const vite = await readFile("vite.config.ts", "utf8");
  const tauri = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));

  assert.match(vite, /outDir:\s*["']dist-tauri-ui["']/);
  assert.match(vite, /host:\s*["']127\.0\.0\.1["']/);
  assert.match(vite, /port:\s*1420/);
  assert.deepEqual(vite.match(/envPrefix:\s*\[[^\]]+\]/)?.[0], 'envPrefix: ["TAURI_ENV_"]');
  assert.equal(tauri.build.frontendDist, "../dist-tauri-ui");
  assert.equal(tauri.build.devUrl, "http://127.0.0.1:1420");
  assert.equal(tauri.identifier, "com.aivirtualassistant.desktop");
  const capability = JSON.parse(await readFile("src-tauri/capabilities/main.json", "utf8"));
  assert.deepEqual(capability.windows, ["main"]);
  assert.deepEqual(capability.permissions, [
    "core:default",
    "allow-foundation-get-status",
    "allow-secret-set",
    "allow-secret-delete",
    "allow-secret-status",
    "allow-diagnostics-export",
    "allow-config-get-startup-state",
    "allow-config-restore-last-good",
    "allow-config-restore-defaults",
    "allow-open-app-directory",
  ]);
  assert.doesNotMatch(JSON.stringify(capability), /shell:allow-(?:execute|spawn)|fs:|https?:\/\/|"\*"/i);
  assert.equal(pkg.scripts.dev, "next dev -H 127.0.0.1");
  assert.equal(pkg.scripts.build, "next build");
  assert.equal(pkg.scripts["build:desktop"], "tsc -p tsconfig.desktop.json");
  assert.equal(
    pkg.scripts["make:windows"],
    "npm run build && npm run build:standalone && npm run build:desktop && npm run build:audio-bridge && npm run prepare:prerequisites && electron-builder --win nsis --x64 && npm run test:packaged-runtime",
  );
});
