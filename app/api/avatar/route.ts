import { NextResponse } from "next/server";
import {
  MAX_AVATAR_BYTES,
  clearAvatar,
  getAvatarMetadata,
  saveAvatar
} from "../../../lib/avatar";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await getAvatarMetadata(), {
    headers: { "Cache-Control": "no-store" }
  });
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("avatar");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { code: "MISSING_FILE", message: "请选择图片或视频文件" },
        { status: 422 }
      );
    }
    return NextResponse.json(await saveAvatar(file));
  } catch (error) {
    const code = error instanceof Error ? error.message : "UNKNOWN";
    if (code === "INVALID_SIZE") {
      return NextResponse.json(
        { code, message: `素材不能为空且不能超过 ${MAX_AVATAR_BYTES / 1024 / 1024}MB` },
        { status: 413 }
      );
    }
    if (code === "UNSUPPORTED_MEDIA") {
      return NextResponse.json(
        { code, message: "仅支持真实的 JPEG、PNG、WebP、MP4 或 WebM 文件" },
        { status: 415 }
      );
    }
    return NextResponse.json(
      { code: "UPLOAD_FAILED", message: "素材保存失败" },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    await clearAvatar();
    return NextResponse.json({ available: false });
  } catch {
    return NextResponse.json(
      { code: "DELETE_FAILED", message: "恢复默认头像失败" },
      { status: 500 }
    );
  }
}
