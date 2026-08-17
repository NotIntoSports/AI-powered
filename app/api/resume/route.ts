import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { forwardControlResume } from "./forward";

export const runtime = "nodejs";

export async function GET() {
  return forwardControlResume("/api/v1/client/resumes");
}

export async function POST(request: Request) {
  const token = (await cookies()).get("control_api_token")?.value;
  if (!token) {
    return NextResponse.json(
      { code: "UNAUTHENTICATED", message: "请先在客户端登录后再管理资料" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }
  const incoming = await request.formData();
  const file = incoming.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { code: "INVALID_INPUT", message: "请选择 PDF 或 Word 资料" },
      { status: 422 }
    );
  }
  const body = new FormData();
  const candidateName = incoming.get("candidateName");
  if (typeof candidateName === "string" && candidateName.trim()) {
    body.set("candidateName", candidateName.trim());
  }
  body.set("file", file, file.name);
  return forwardControlResume("/api/v1/client/resumes", {
    method: "POST",
    body
  });
}
