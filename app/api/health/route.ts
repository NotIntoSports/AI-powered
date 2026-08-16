import { NextResponse } from "next/server";
import {
  getTranscriptionProvider,
  getTranscriptionSource,
  isTranscriptionConfigured,
  isTranscriptionReady
} from "../../../lib/transcription";
import {
  getModelRuntimeConfig,
  isLocalModelEndpoint,
  isModelRuntimeConfigured,
  pingControlApi
} from "../../../lib/runtime-config";
import { listWindowsSpeechVoices } from "../../../lib/windows-tts";
import { SERVICE_ID } from "../../../lib/service-identity";

export async function GET() {
  const [runtime, transcriptionConfigured, ttsVoices, transcriptionSource, management] = await Promise.all([
    getModelRuntimeConfig(),
    isTranscriptionConfigured(),
    listWindowsSpeechVoices().catch(() => []),
    getTranscriptionSource(),
    pingControlApi()
  ]);
  return NextResponse.json({
    service: SERVICE_ID,
    status: "ok",
    modelConfigured: isModelRuntimeConfigured(runtime),
    modelApiKeyConfigured: Boolean(runtime.apiKey),
    modelLocalEndpoint: isLocalModelEndpoint(runtime.baseUrl),
    modelSource: runtime.source,
    modelName: runtime.model,
    ttsConfigured: ttsVoices.length > 0,
    ttsVoiceCount: ttsVoices.length,
    transcriptionProvider: getTranscriptionProvider(),
    transcriptionSource,
    transcriptionConfigured,
    transcriptionReady: transcriptionConfigured && await isTranscriptionReady(),
    managementReachable: management.reachable,
    managementRttMs: management.rttMs
  });
}
