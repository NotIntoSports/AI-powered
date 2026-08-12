import { NextResponse } from "next/server";
import { getArchivedSession } from "../../../../../lib/interview";
import {
  interviewExportFilename,
  renderInterviewMarkdown
} from "../../../../../lib/interview-export";

export async function GET(
  request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await context.params;
  const session = await getArchivedSession(sessionId);
  if (!session) {
    return NextResponse.json({ code: "NOT_FOUND", message: "对话记录不存在" }, { status: 404 });
  }
  const markdown = new URL(request.url).searchParams.get("format") === "markdown";
  const filename = interviewExportFilename(session, markdown ? "md" : "json");
  return new NextResponse(
    markdown ? renderInterviewMarkdown(session) : `${JSON.stringify(session, null, 2)}\n`,
    {
    headers: {
      "Content-Type": markdown
        ? "text/markdown; charset=utf-8"
        : "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store"
    }
  });
}
