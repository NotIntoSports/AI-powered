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
  assert.match(source, /app\.setName\(["']AI Digital Human["']\)/);
  assert.match(source, /window\.removeMenu\(\)/);
  assert.match(source, /titleBarStyle:\s*["']hidden["']/);
  assert.match(source, /titleBarOverlay:\s*\{/);
  assert.match(source, /height:\s*36/);
  assert.match(source, /desktop-startup\.log/);
  assert.match(source, /dialog\.showErrorBox/);
  assert.match(source, /setPermissionCheckHandler/);
  assert.match(source, /setPermissionRequestHandler/);
  assert.match(source, /permission === ["']media["']/);
  assert.match(source, /isAllowedLocalUrl\(requestingUrl, baseUrl\)/);
});

test("preload exposes only the desktop status method", async () => {
  const source = await readFile(new URL("../../desktop/preload.ts", import.meta.url), "utf8");
  assert.match(source, /getStatus/);
  assert.doesNotMatch(source, /exec|spawn|shell|readFile|writeFile/);
});

test("fullscreen stage accounts for the desktop title overlay", async () => {
  const styles = await readFile(new URL("../../app/styles.css", import.meta.url), "utf8");
  assert.match(styles, /height:\s*calc\(100dvh\s*-\s*env\(titlebar-area-height,\s*0px\)\)/);
  assert.doesNotMatch(styles, /\.stage\s*\{[^}]*width:\s*100vw/s);
});

test("desktop workspace uses panel scrolling instead of page scrolling", async () => {
  const page = await readFile(new URL("../../app/page.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../../app/styles.css", import.meta.url), "utf8");
  assert.match(page, /className="workspaceMain"/);
  assert.match(page, /className="workspaceTools"/);
  assert.match(styles, /\.workspacePage\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(styles, /\.workspacePage \.transcript \.messages\s*\{[^}]*overflow-y:\s*auto/s);
});
