import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("NSIS uses an automatic per-user installation directory", async () => {
  const config = await readFile(new URL("../../electron-builder.yml", import.meta.url), "utf8");
  const include = await readFile(new URL("../../build/installer.nsh", import.meta.url), "utf8");
  assert.match(config, /include:\s*build\/installer\.nsh/);
  assert.match(config, /oneClick:\s*true/);
  assert.match(config, /perMachine:\s*false/);
  assert.match(config, /runAfterFinish:\s*true/);
  assert.doesNotMatch(config, /allowToChangeInstallationDirectory:\s*true/);
  assert.match(config, /createDesktopShortcut:\s*true/);
  assert.match(config, /createStartMenuShortcut:\s*true/);
  assert.match(include, /APP_FILENAME "AI Digital Human"/);
});
