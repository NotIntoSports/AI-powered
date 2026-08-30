import { NextResponse } from "next/server";
import { fetchDesktopControlJson } from "../../../../lib/runtime-config";

export async function GET() {
  const data = await fetchDesktopControlJson<{ mode?: string; enabled?: boolean }>(
    "/api/v1/client/settings/pipeline"
  );
  const mode = data?.mode === "e2e" ? "e2e" : "cascaded";
  return NextResponse.json({
    mode,
    enabled: data?.enabled !== false
  });
}
