import { NextResponse } from "next/server";

export async function GET() {
  const managed = process.env.AI_INTERVIEW_OBS_MANAGED === "1";
  const configuredBaseUrl = process.env.AI_INTERVIEW_BASE_URL || "";
  const baseUrl = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(configuredBaseUrl)
    ? configuredBaseUrl
    : "";
  return NextResponse.json({
    managed,
    url: "ws://127.0.0.1:4455",
    password: managed ? process.env.AI_INTERVIEW_OBS_PASSWORD || "" : "",
    stageUrl: baseUrl ? `${baseUrl}/stage` : ""
  }, {
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
