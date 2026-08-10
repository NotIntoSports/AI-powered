import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

const appPort = 3102;
const nextBin = path.join(
  process.cwd(),
  "node_modules",
  "next",
  "dist",
  "bin",
  "next"
);
const app = spawn(process.execPath, [nextBin, "start", "-p", String(appPort)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "ignore"
});

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/api/health`);
      const body = await response.json();
      if (
        response.ok &&
        body.service === "authorized-interview-screen-helper" &&
        body.status === "ok"
      ) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Next.js security-header smoke server did not start");
}

try {
  await waitForServer();
  for (const pathname of ["/", "/stage", "/api/health"]) {
    const response = await fetch(`http://127.0.0.1:${appPort}${pathname}`);
    assert.equal(response.status, 200, pathname);
    const csp = response.headers.get("content-security-policy") || "";
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'/);
    assert.match(csp, /connect-src 'self' ws:\/\/127\.0\.0\.1:\* ws:\/\/localhost:\*/);
    assert.match(csp, /media-src 'self' blob:/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("permissions-policy") || "", /camera=\(self\)/);
    assert.equal(response.headers.has("x-powered-by"), false);
  }
  process.stdout.write("security response headers smoke test passed\n");
} finally {
  app.kill("SIGTERM");
}
