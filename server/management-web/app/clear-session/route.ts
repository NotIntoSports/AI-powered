import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "../../lib/control-api";

export async function POST() {
  const response = NextResponse.json({ cleared: true });
  response.cookies.set(SESSION_COOKIE, "", {
    path: "/",
    maxAge: 0,
    httpOnly: true,
    sameSite: "strict"
  });
  return response;
}
