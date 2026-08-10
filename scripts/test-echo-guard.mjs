import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile("features/audio/echo-guard.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { advanceEchoGuard, armEchoGuard, idleEchoGuard } = await import(moduleUrl);

const armed = armEchoGuard(1_000);
assert.equal(armed.command, "pause");
assert.deepEqual(armed.state, { phase: "awaiting-speech", deadline: 31_000 });

const notStarted = advanceEchoGuard(armed.state, "ready", 2_000);
assert.equal(notStarted.command, null);
assert.equal(notStarted.state.phase, "awaiting-speech");

const speaking = advanceEchoGuard(notStarted.state, "speaking", 3_000);
assert.equal(speaking.command, null);
assert.equal(speaking.state.phase, "speaking");

const finished = advanceEchoGuard(speaking.state, "ready", 4_000);
assert.equal(finished.command, "start");
assert.deepEqual(finished.state, idleEchoGuard);

const timedOut = advanceEchoGuard(armed.state, "idle", 31_000);
assert.equal(timedOut.command, "start");
assert.deepEqual(timedOut.state, idleEchoGuard);

const errored = advanceEchoGuard(armed.state, "error", 2_000);
assert.equal(errored.command, "start");
assert.deepEqual(errored.state, idleEchoGuard);

assert.equal(advanceEchoGuard(idleEchoGuard, "ready", 10_000).command, null);

process.stdout.write("echo guard state test passed\n");
