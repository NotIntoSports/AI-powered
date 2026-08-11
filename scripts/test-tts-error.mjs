import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile("features/audio/tts-error.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const { describeTtsError } = await import(moduleUrl);

assert.match(describeTtsError("sapi-audio:sapi-http-500; web-speech:not-allowed"), /交互/);
assert.match(describeTtsError("sapi-http-503"), /SAPI/);
assert.match(describeTtsError("voice-unavailable"), /中文语音包/);
assert.match(describeTtsError("web-speech:audio-capture"), /独占/);
assert.match(describeTtsError("network timeout"), /连接/);
assert.doesNotMatch(describeTtsError("unknown"), /unknown|sapi-http/i);
assert.match(describeTtsError(""), /重新测试/);

process.stdout.write("TTS error description test passed\n");
