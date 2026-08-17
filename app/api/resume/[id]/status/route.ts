import { NextResponse } from "next/server";
import { forwardControlResume } from "../../forward";

export const runtime = "nodejs";

const resumeIdPattern = /^[a-f0-9]{32}$/i;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  if (!resumeIdPattern.test(id)) {
    return NextResponse.json(
      { code: "RESUME_NOT_FOUND", message: "资料不存在或已删除" },
      { status: 404, headers: { "Cache-Control": "no-store" } }
    );
  }
  return forwardControlResume(`/api/v1/client/resumes/${encodeURIComponent(id)}/status`);
}
