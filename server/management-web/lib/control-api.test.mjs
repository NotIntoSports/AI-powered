import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const root = dirname(fileURLToPath(import.meta.url));

function loadControlApi() {
  const source = readFileSync(join(root, "control-api.ts"), "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 }
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`;
  return import(moduleUrl);
}

test("login body always uses browser purpose and does not rename the password field", async () => {
  const api = await loadControlApi();
  const body = api.buildLoginBody("Owner", "correct horse battery staple");
  assert.equal(body.purpose, "browser");
  assert.equal(body.username, "Owner");
  assert.equal(body.password, "correct horse battery staple");
  assert.deepEqual(Object.keys(body).sort(), ["password", "purpose", "username"]);
});

test("error parser uses server message and ignores password-shaped fields", async () => {
  const api = await loadControlApi();
  const error = api.parseAPIError({
    code: "INVALID_CREDENTIALS",
    message: "invalid username or password",
    requestId: "req-1",
    password: "should-not-display"
  });
  assert.equal(error.code, "INVALID_CREDENTIALS");
  assert.equal(error.message, "invalid username or password");
  assert.equal(error.requestId, "req-1");
  assert.equal(api.displayError(error).includes("should-not-display"), false);
});

test("public user parser keeps online presence fields", async () => {
  const api = await loadControlApi();
  const user = api.publicUserFromUnknown({
    id: "u1",
    username: "owner",
    role: "admin",
    status: "active",
    createdAt: "2026-08-16T00:00:00Z",
    updatedAt: "2026-08-16T00:00:00Z",
    online: true,
    activeSessionCount: 2,
    lastSeenAt: "2026-08-16T00:01:00Z"
  });
  assert.equal(user.online, true);
  assert.equal(user.activeSessionCount, 2);
  assert.equal(user.lastSeenAt, "2026-08-16T00:01:00Z");
});

test("login page has no registration or password-recovery entry", () => {
  const loginPage = readFileSync(join(root, "..", "app", "login", "page.tsx"), "utf8");
  assert.match(loginPage, /buildLoginBody/);
  assert.match(loginPage, /没有公开注册/);
  assert.doesNotMatch(loginPage, /<a[\s\S]{0,80}注册|找回密码|forgot password|sign up/i);
});
