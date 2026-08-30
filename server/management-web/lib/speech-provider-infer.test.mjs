import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = dirname(fileURLToPath(import.meta.url));

async function loadInfer() {
  const source = readFileSync(join(root, "speech-provider-infer.ts"), "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 }
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`;
  return import(moduleUrl);
}

test("speech:aliyun and speech:volcengine provider ids", async () => {
  const api = await loadInfer();
  assert.equal(api.inferSpeechProviderFromCatalog({ providerId: "speech:aliyun" }), "aliyun");
  assert.equal(api.inferSpeechProviderFromCatalog({ providerId: "speech:volcengine" }), "volcengine");
});

test("TOKENPLAN / CosyVoice map to aliyun", async () => {
  const api = await loadInfer();
  assert.equal(
    api.inferSpeechProviderFromCatalog({
      providerName: "阿里云 TOKENPLAN",
      baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      modelId: "qwen-audio-3.0-realtime-plus"
    }),
    "aliyun"
  );
  assert.equal(api.inferSpeechProviderFromCatalog({ modelId: "cosyvoice-v3-flash" }), "aliyun");
});

test("豆包 / volcengine markers", async () => {
  const api = await loadInfer();
  assert.equal(
    api.inferSpeechProviderFromCatalog({ providerName: "豆包语音", modelId: "seed-icl-2.0" }),
    "volcengine"
  );
});

test("pipeline mode picks tts vs e2e hint", async () => {
  const api = await loadInfer();
  assert.equal(
    api.inferSpeechProviderFromPipeline({
      mode: "cascaded",
      tts: { providerId: "speech:aliyun", modelId: "cosyvoice-v3-flash" },
      e2e: { providerId: "speech:volcengine" }
    }),
    "aliyun"
  );
  assert.equal(
    api.inferSpeechProviderFromPipeline({
      mode: "e2e",
      tts: { providerId: "speech:volcengine" },
      e2e: { providerName: "阿里云 TOKENPLAN", modelId: "qwen-audio-3.0-realtime-plus" }
    }),
    "aliyun"
  );
});

test("unknown returns null; label helper", async () => {
  const api = await loadInfer();
  assert.equal(api.inferSpeechProviderFromCatalog({ modelId: "gpt-4o-mini" }), null);
  assert.equal(api.speechProviderLabel("aliyun"), "阿里云");
  assert.equal(api.speechProviderLabel("volcengine"), "豆包");
});
