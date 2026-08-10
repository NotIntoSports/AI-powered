import { NextResponse } from "next/server";
import { listArchivedSessions } from "../../../lib/interview";

export async function GET() {
  return NextResponse.json(await listArchivedSessions(), {
    headers: { "Cache-Control": "no-store" }
  });
}
