import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("workspace records Agent turns without selecting a local pipeline", async () => {
  const page = await readFile(new URL("../../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /useAgentE2eTurn/);
  assert.doesNotMatch(page, /useAutoAnswerSubmit|pipelineMode|\/api\/settings\/pipeline|\/api\/transcribe/);
  assert.doesNotMatch(page, /modelConfigured|startVoiceActivityDetection|recordAudioSegment|queueTranscription/);
});

test("session route does not call a model for answer retry correction or report", async () => {
  const route = await readFile(new URL("../../app/api/session/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /generateRoleResponse|generateInterviewReport|getModelRuntimeConfig|probeConfiguredModel/);
  assert.doesNotMatch(route, /MODEL_TIMEOUT|MISSING_API_KEY|MODEL_ERROR|本机模型|远程模型密钥/);
  assert.match(route, /AGENT_ACTION_REQUIRED/);
});

test("desktop health does not load model or transcription credentials", async () => {
  const route = await readFile(new URL("../../app/api/health/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /getModelRuntimeConfig|getSpeechRuntimeConfig|getTranscription/);
  assert.doesNotMatch(route, /modelApiKeyConfigured|modelName|transcriptionProvider/);
});

test("desktop no longer exposes legacy model pipeline or transcription routes", async () => {
  for (const path of [
    "../../app/api/settings/model/route.ts",
    "../../app/api/settings/pipeline/route.ts",
    "../../app/api/transcribe/route.ts",
    "../../lib/llm.ts",
    "../../lib/model-probe.ts",
    "../../lib/transcription.ts",
    "../../lib/model-output.ts",
    "../../lib/prompt-transcript.ts",
    "../../lib/question-dedup.ts",
    "../../scripts/setup-whisper.ps1",
    "../../scripts/start-whisper.ps1",
    "../../scripts/setup-ollama.ps1"
  ]) {
    await assert.rejects(access(new URL(path, import.meta.url)));
  }
});

test("control API only exposes the unified Agent voice route runtime", async () => {
  const router = await readFile(new URL("../../server/control-api/internal/httpapi/router.go", import.meta.url), "utf8");
  assert.doesNotMatch(router, /r\.Get\("\/settings\/(ai|asr|pipeline)"/);
  assert.doesNotMatch(router, /agentSettings\.getAgent(AI|Speech|Pipeline)/);
  assert.match(router, /r\.Get\("\/settings\/voice-route"/);
});

test("desktop runtime config only handles control API transport and local secret storage", async () => {
  const runtime = await readFile(new URL("../../lib/runtime-config.ts", import.meta.url), "utf8");
  assert.doesNotMatch(runtime, /client\/settings\/(ai|pipeline)|getModelRuntimeConfig|ModelRuntimeConfig/);
  assert.match(runtime, /fetchDesktopControlResult/);
  assert.match(runtime, /localSettingsDirectory/);
});
