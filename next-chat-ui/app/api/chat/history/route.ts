import { NextResponse } from "next/server";
import { deleteAllChatSessions, deleteChatSession, listChatSessions } from "@/lib/chat-store";
import { getSessionUserId } from "@/lib/auth-session";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = getSessionUserId(req) || Number(searchParams.get("userId") || 0);

    if (!Number.isFinite(userId) || userId <= 0) {
      return NextResponse.json({ sessions: [] });
    }

    const sessions = await listChatSessions(userId);
    return NextResponse.json({ sessions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load chat history";
    return NextResponse.json({ message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const body = (await req.json()) as { sessionId?: string; userId?: number; deleteAll?: boolean };
    const sessionId = body.sessionId;
    const userId = getSessionUserId(req) || Number(body.userId || 0);

    if (body.deleteAll === true) {
      await deleteAllChatSessions(userId);
      return NextResponse.json({ success: true });
    }

    if (!sessionId) {
      return NextResponse.json({ message: "sessionId is required" }, { status: 400 });
    }

    if (!userId || !Number.isFinite(userId)) {
      return NextResponse.json({ message: "userId is required" }, { status: 400 });
    }

    await deleteChatSession(sessionId, userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete chat";
    return NextResponse.json({ message }, { status: 500 });
  }
}
