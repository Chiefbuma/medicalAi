import { NextResponse } from "next/server";

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "http://localhost:5678/webhook/8e20da7d-f205-43c3-950f-b97b8ccb3025/chat";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { chatInput?: string; sessionId?: string };
    const chatInput = body.chatInput?.trim();
    if (!chatInput) return NextResponse.json({ message: "chatInput is required" }, { status: 400 });

    const sessionId = body.sessionId || `session_${Math.random().toString(36).slice(2)}`;
    const res = await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "sendMessage", sessionId, chatInput }),
    });

    const text = await res.text();
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { data = { output: text }; }
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ message: "Request failed" }, { status: 500 });
  }
}
