import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile("features/rtc/auto-answer-submit.ts", "utf8");
const helper = source.match(/export function isOutsideEchoWindow[\s\S]*?\n}/)?.[0];
assert.ok(helper, "echo-window helper must exist");
const compiled = ts.transpileModule(helper, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { isOutsideEchoWindow } = await import(moduleUrl);

assert.equal(isOutsideEchoWindow({ aiSpeaking: true, now: 10_000, tailUntil: 0 }), false);
assert.equal(isOutsideEchoWindow({ aiSpeaking: false, now: 10_000, tailUntil: 10_500 }), false);
assert.equal(isOutsideEchoWindow({ aiSpeaking: false, now: 10_500, tailUntil: 10_500 }), true);
process.stdout.write("auto answer echo window test passed\n");
