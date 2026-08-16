import { NextResponse } from "next/server";
import { forwardControlResume } from "../forward";

export const runtime = "nodejs";

const resumeIdPattern = /^[a-f0-9]{32}$/i;

function invalidResume() {
  return NextResponse.json(
    { code: "RESUME_NOT_FOUND", message: "简历不存在或已删除" },
    { status: 404, headers: { "Cache-Control": "no-store" } }
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  if (!resumeIdPattern.test(id)) {
    return invalidResume();
  }
  return forwardControlResume(`/api/v1/client/resumes/${encodeURIComponent(id)}/download`);
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  if (!resumeIdPattern.test(id)) {
    return invalidResume();
  }
  return forwardControlResume(`/api/v1/client/resumes/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}
