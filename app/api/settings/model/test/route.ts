import { NextResponse } from "next/server";
import { probeConfiguredModel } from "../../../../../lib/model-probe";

export async function POST() {
  const result = await probeConfiguredModel();
  return NextResponse.json(result, {
    status: result.reachable ? 200 : 503,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
