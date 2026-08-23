import { formatPipelineLog, normalizePipelineEvent } from "../../../lib/pipeline-diagnostics.ts";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > 4_096) return Response.json({ code: "PAYLOAD_TOO_LARGE" }, { status: 413 });
  const event = normalizePipelineEvent(await request.json().catch(() => null));
  if (!event) return Response.json({ code: "INVALID_PIPELINE_EVENT" }, { status: 422 });
  console.log(formatPipelineLog(event));
  return new Response(null, { status: 204 });
}
