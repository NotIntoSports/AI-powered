import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile("features/audio/transcription-turn.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { canAutoSubmitTranscription } = await import(moduleUrl);

assert.equal(canAutoSubmitTranscription({
  sessionStatus: "running",
  currentRevision: 4,
  capturedRevision: 4,
  lastTranscriptRole: "interviewer"
}), true);
assert.equal(canAutoSubmitTranscription({
  sessionStatus: "running",
  currentRevision: 5,
  capturedRevision: 4,
  lastTranscriptRole: "interviewer"
}), false);
assert.equal(canAutoSubmitTranscription({
  sessionStatus: "running",
  currentRevision: 4,
  capturedRevision: 4,
  lastTranscriptRole: "candidate"
}), false);
assert.equal(canAutoSubmitTranscription({
  sessionStatus: "finished",
  currentRevision: 4,
  capturedRevision: 4,
  lastTranscriptRole: "interviewer"
}), false);

process.stdout.write("transcription turn guard test passed\n");
