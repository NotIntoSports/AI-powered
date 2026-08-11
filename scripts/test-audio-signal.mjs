import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile("features/audio/audio-signal.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { calculatePcmRms, hasMeaningfulAudioSignal } = await import(moduleUrl);

assert.equal(calculatePcmRms(new Uint8Array()), 0);
assert.equal(calculatePcmRms(Uint8Array.from([128, 128, 128, 128])), 0);
assert.ok(calculatePcmRms(Uint8Array.from([96, 160, 96, 160])) > 0.2);
assert.equal(hasMeaningfulAudioSignal(0.01, 0), false);
assert.equal(hasMeaningfulAudioSignal(0.02, 0), true);
assert.equal(hasMeaningfulAudioSignal(0.03, 0.01), false);
assert.equal(hasMeaningfulAudioSignal(0.04, 0.01), true);

process.stdout.write("audio signal detection test passed\n");
