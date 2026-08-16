import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const TOKEN_COOKIE = "control_api_token";

function controlApiOrigin() {
  return (process.env.CONTROL_API_ORIGIN || "http://175.27.132.61").replace(/\/$/, "");
}

export async function POST(request: Request) {
  const token = (await cookies()).get(TOKEN_COOKIE)?.value;
  if (!token) {
    return NextResponse.json(
      { code: "UNAUTHENTICATED", message: "请先连接管理端再上传简历" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }
  const incoming = await request.formData();
  const file = incoming.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { code: "INVALID_INPUT", message: "请选择 PDF 或 Word 简历" },
      { status: 422 }
    );
  }
  const body = new FormData();
  const candidateName = incoming.get("candidateName");
  if (typeof candidateName === "string" && candidateName.trim()) {
    body.set("candidateName", candidateName.trim());
  }
  body.set("file", file, file.name);
  const response = await fetch(`${controlApiOrigin()}/api/v1/client/resumes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body,
    cache: "no-store"
  });
  const payload = await response.json().catch(() => null);
  return NextResponse.json(payload, {
    status: response.status,
    headers: { "Cache-Control": "no-store" }
  });
}
