import { NextResponse } from "next/server";

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "http://host.docker.internal:5678/webhook/8e20da7d-f205-43c3-950f-b97b8ccb3025/chat";

function buildDocumentOnlyPrompt(userQuestion: string): string {
  return [
    "You are MedAssistant. Follow these mandatory rules:",
    "1) Use ONLY information that is explicitly present in retrieved document content.",
    "2) Do NOT use outside medical knowledge, memory, assumptions, or general guidelines.",
    "3) If the document does not explicitly contain the answer, reply exactly:",
    "\"I don’t have enough evidence in the provided document to answer that safely.\"",
    "4) Do not invent drug names, doses, or management steps.",
    "5) If answering, keep the response concise and quote exact key values from the document when available.",
    "",
    `User question: ${userQuestion}`,
  ].join("\n");
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { chatInput?: string; sessionId?: string };
    const chatInput = body.chatInput?.trim();

    if (!chatInput) {
      return NextResponse.json({ message: "chatInput is required" }, { status: 400 });
    }

    const sessionId = body.sessionId || `session_${Math.random().toString(36).slice(2)}`;

    const upstream = await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "sendMessage",
        sessionId,
        chatInput: buildDocumentOnlyPrompt(chatInput),
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      return NextResponse.json(
        { message: "Upstream webhook error", details: errText },
        { status: upstream.status },
      );
    }

    if (!upstream.body) {
      const text = await upstream.text();
      return new Response(text, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    return NextResponse.json({ message: "Request failed" }, { status: 500 });
  }
}
