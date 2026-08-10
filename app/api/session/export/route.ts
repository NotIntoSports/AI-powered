import { NextResponse } from "next/server";
import { getSession } from "../../../../lib/interview";
import {
  interviewExportFilename,
  renderInterviewMarkdown
} from "../../../../lib/interview-export";

export async function GET(request: Request) {
  const session = await getSession();
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
