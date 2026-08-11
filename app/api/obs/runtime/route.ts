import { NextResponse } from "next/server";
import { getSetting } from "../../../../lib/database";
import { runDpapi } from "../../../../lib/runtime-config";

function isTrustedRuntimeRequest(request: Request) {
  const target = new URL(request.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) return false;
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site" || fetchSite === "same-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).origin === target.origin; } catch { return false; }
}

export async function GET(request: Request) {
  if (!isTrustedRuntimeRequest(request)) {
    return NextResponse.json({ code: "FORBIDDEN" }, { status: 403 });
  }
  let password = process.env.AI_INTERVIEW_OBS_PASSWORD || "";
  if (!password) {
    const protectedPassword = getSetting("obs_websocket_password");
    if (protectedPassword) {
      try { password = runDpapi("Unprotect", protectedPassword); } catch { password = ""; }
    }
  }
  const managed = process.env.AI_INTERVIEW_OBS_MANAGED === "1" || Boolean(password);
  return NextResponse.json({
    managed,
    url: "ws://127.0.0.1:4455",
    password: managed ? password : ""
  }, {
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
