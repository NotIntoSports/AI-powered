import { NextResponse } from "next/server";
import { pingControlApi } from "../../../lib/runtime-config";
import { listWindowsSpeechVoices } from "../../../lib/windows-tts";
import { SERVICE_ID } from "../../../lib/service-identity";

export async function GET() {
  const [ttsVoices, management] = await Promise.all([
    listWindowsSpeechVoices().catch(() => []),
    pingControlApi()
  ]);
  return NextResponse.json({
    service: SERVICE_ID,
    status: "ok",
    ttsConfigured: ttsVoices.length > 0,
    ttsVoiceCount: ttsVoices.length,
    ttsSource: ttsVoices.length > 0 ? "sapi" : "none",
    managementReachable: management.reachable,
    managementRttMs: management.rttMs
  });
}
