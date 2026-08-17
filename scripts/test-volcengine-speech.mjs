import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const dir = await mkdtemp(path.join(os.tmpdir(), "speech-test-"));
for (const file of ["pcm-wav.ts", "voice-clone-script.ts", "volcengine-speech.ts"]) {
  const source = await readFile(path.join("lib", file), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText
    .replaceAll('from "./pcm-wav"', 'from "./pcm-wav.mjs"')
    .replaceAll('from "./voice-clone-script"', 'from "./voice-clone-script.mjs"');
  await writeFile(path.join(dir, file.replace(".ts", ".mjs")), compiled);
}

const speech = await import(pathToFileURL(path.join(dir, "volcengine-speech.mjs")).href);
const wav = await import(pathToFileURL(path.join(dir, "pcm-wav.mjs")).href);
const script = await import(pathToFileURL(path.join(dir, "voice-clone-script.mjs")).href);

assert.match(script.VOICE_CLONE_SCRIPT, /你好，我是今天的虚拟助手/);
assert.equal(script.DEFAULT_CUSTOM_SPEAKER_ID, "custom_zh_interviewer");

const apiHeaders = speech.volcengineSpeechHeaders({ apiKey: "volc-secret-key" }, "seed-icl-2.0", "req-1");
assert.equal(apiHeaders["X-Api-Key"], "volc-secret-key");
assert.equal(apiHeaders["X-Api-Resource-Id"], "seed-icl-2.0");
assert.equal(apiHeaders["X-Api-App-Key"], undefined);
assert.equal(apiHeaders["X-Api-Access-Key"], undefined);

const tokenHeaders = speech.volcengineSpeechHeaders({
  appId: "8358554445",
  accessToken: "volc-access-token"
});
assert.equal(tokenHeaders["X-Api-Key"], undefined);
assert.equal(tokenHeaders["X-Api-App-Key"], "8358554445");
assert.equal(tokenHeaders["X-Api-Access-Key"], "volc-access-token");

const cloneBody = speech.buildVoiceCloneBody({
  audioBase64: "QQ==",
  format: "wav",
  text: script.VOICE_CLONE_SCRIPT
});
assert.equal(cloneBody.speaker_id, "custom_speaker_id");
assert.equal(cloneBody.custom_speaker_id, "custom_zh_interviewer");
assert.equal(cloneBody.text, script.VOICE_CLONE_SCRIPT);
assert.equal(cloneBody.audio.format, "wav");

const prepaid = speech.buildVoiceCloneBody({
  audioBase64: "QQ==",
  text: script.VOICE_CLONE_SCRIPT,
  speakerId: "S_abc12345"
});
assert.equal(prepaid.speaker_id, "S_abc12345");
assert.equal(prepaid.custom_speaker_id, undefined);

assert.equal(speech.parseVoiceCloneSpeakerId({ speaker_id: "S_cloned01" }, "fallback"), "S_cloned01");
assert.equal(
  speech.parseVoiceCloneSpeakerId({ speaker_id: "custom_speaker_id" }, "custom_zh_interviewer"),
  "custom_zh_interviewer"
);

const ttsBody = speech.buildUnidirectionalTtsBody("你好", "custom_zh_interviewer");
assert.equal(ttsBody.req_params.speaker, "custom_zh_interviewer");
assert.equal(ttsBody.req_params.audio_params.format, "wav");

const pcm = Buffer.from([0, 0, 1, 0]);
const ttsAudio = speech.concatTtsAudioChunks([
  JSON.stringify({ code: 0, data: pcm.toString("base64") }),
  JSON.stringify({ code: 20000000, message: "OK", data: "" })
].join("\n"));
assert.equal(String.fromCharCode(...ttsAudio.slice(0, 4)), "RIFF");
assert.equal(String.fromCharCode(...ttsAudio.slice(8, 12)), "WAVE");

assert.equal(speech.mapTranscriptionFormat("audio/webm;codecs=opus"), "ogg");
assert.equal(speech.mapTranscriptionFormat("audio/wav"), "wav");
assert.equal(speech.parseFlashAsrText({ result: { text: " 你好，面试官 " } }), "你好，面试官");
assert.deepEqual(speech.buildFlashAsrBody("QQ==", "ogg").audio, { data: "QQ==", format: "ogg" });

assert.equal(wav.cloneDurationStatus(7.9), "too-short");
assert.equal(wav.cloneDurationStatus(8), "ok");
assert.equal(wav.cloneDurationStatus(20), "ok");
assert.equal(wav.cloneDurationStatus(25.1), "too-long");
assert.equal(wav.clampCloneSampleCount(30 * 24000, 24000), 25 * 24000);

const encoded = wav.encodePcm16Wav(new Float32Array(24000 * 2), 24000);
assert.equal(String.fromCharCode(...encoded.slice(0, 4)), "RIFF");
assert.ok(encoded.byteLength > 44);

process.stdout.write("volcengine speech mapping test passed\n");
