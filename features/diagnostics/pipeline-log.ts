import { normalizePipelineEvent, type PipelineEvent } from "../../lib/pipeline-diagnostics.ts";

export async function emitPipelineEvent(event: PipelineEvent): Promise<void> {
  const normalized = normalizePipelineEvent(event);
  if (!normalized) return;
  try {
    await fetch("/api/pipeline-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(normalized),
      keepalive: true
    });
  } catch {
    // Diagnostics must never interrupt the audio or conversation pipeline.
  }
}
