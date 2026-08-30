import type { SubtitleSink } from "../../lib/subtitles/sink.ts";
import type { SubtitleTransport } from "../../lib/subtitles/transport.ts";

export async function createSubtitleTransport(sink: SubtitleSink): Promise<SubtitleTransport> {
  const { LiveKitRtcAdapter } = await import("./livekit-adapter.ts");
  return new LiveKitRtcAdapter(sink);
}
