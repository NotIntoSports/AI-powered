import { VolcengineRtcAdapter } from "./volcengine-adapter.ts";
import type { SubtitleSink } from "../../lib/subtitles/sink.ts";
import type { SubtitleProvider, SubtitleTransport } from "../../lib/subtitles/transport.ts";

export async function createSubtitleTransport(
  provider: SubtitleProvider,
  sink: SubtitleSink,
  engine?: ConstructorParameters<typeof VolcengineRtcAdapter>[0]
): Promise<SubtitleTransport> {
  if (provider === "livekit") {
    const { LiveKitRtcAdapter } = await import("./livekit-adapter.ts");
    return new LiveKitRtcAdapter(sink);
  }
  if (!engine) throw new Error("VOLCENGINE_ENGINE_REQUIRED");
  return new VolcengineRtcAdapter(engine, sink);
}
