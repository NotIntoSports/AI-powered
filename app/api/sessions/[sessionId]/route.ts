import { NextResponse } from "next/server";
import { deleteArchivedSession } from "../../../../lib/interview";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await context.params;
  const deleted = await deleteArchivedSession(sessionId);
  if (!deleted) {
    return NextResponse.json({ code: "NOT_FOUND", message: "面试记录不存在" }, { status: 404 });
  }
  return NextResponse.json({ deleted: true });
}
