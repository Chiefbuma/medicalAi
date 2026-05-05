"use client";

import { FormEvent, useMemo, useState } from "react";

type Role = "user" | "assistant";
type Msg = { id: string; role: Role; text: string };

function makeId() { return Math.random().toString(36).slice(2); }

function extractAssistantText(payload: Record<string, unknown>): string {
  if (typeof payload.assistant_reply === "string" && payload.assistant_reply.trim()) {
    return payload.assistant_reply;
  }

  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message;
  }

  const output = typeof payload.output === "string" ? payload.output : "";
  if (!output.trim()) {
    return "No response from assistant.";
  }

  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const chunks: string[] = [];

  for (const line of lines) {
    try {
      const evt = JSON.parse(line) as { type?: string; content?: unknown };
      if (evt.type === "item" && typeof evt.content === "string") {
        chunks.push(evt.content);
      }
    } catch {
      // ignore non-JSON lines
    }
  }

  const text = chunks.join("").trim();
  return text || output;
}

export default function ChatInterface() {
  const [messages, setMessages] = useState<Msg[]>([
    { id: makeId(), role: "assistant", text: "Hello. I am your clinical assistant. How can I help today?" },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const canSend = useMemo(() => input.trim().length > 0 && !loading, [input, loading]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q) return;
    setInput("");
    setMessages((prev) => [...prev, { id: makeId(), role: "user", text: q }]);
    setLoading(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatInput: q }),
      });
      const data = (await res.json()) as Record<string, unknown>;
      const answer = extractAssistantText(data);
      setMessages((prev) => [...prev, { id: makeId(), role: "assistant", text: answer }]);
    } catch {
      setMessages((prev) => [...prev, { id: makeId(), role: "assistant", text: "Unable to reach the assistant right now." }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", height: "100vh" }}>
      <aside style={{ borderRight: "1px solid var(--border)", background: "#0b1220", padding: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 14 }}>Clinical Chat</div>
        <button
          style={{ width: "100%", background: "transparent", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", cursor: "pointer" }}
          onClick={() => setMessages([{ id: makeId(), role: "assistant", text: "New session started." }])}
        >
          + New chat
        </button>
      </aside>

      <main style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <header style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", background: "var(--panel)" }}>
          <strong>Clinical Assistant</strong>
        </header>
        <section style={{ flex: 1, overflowY: "auto", padding: "20px max(16px, 12vw)" }}>
          <div style={{ maxWidth: 820, margin: "0 auto", display: "grid", gap: 14 }}>
            {messages.map((m) => (
              <div key={m.id} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                <div style={{ maxWidth: "88%", padding: "12px 14px", borderRadius: 14, lineHeight: 1.45, whiteSpace: "pre-wrap", background: m.role === "user" ? "var(--accent)" : "var(--panel-2)", color: "var(--text)" }}>
                  {m.text}
                </div>
              </div>
            ))}
            {loading && <div style={{ color: "var(--muted)" }}>Assistant is thinking...</div>}
          </div>
        </section>
        <footer style={{ borderTop: "1px solid var(--border)", padding: 14, background: "var(--panel)" }}>
          <form onSubmit={onSubmit} style={{ maxWidth: 900, margin: "0 auto", display: "flex", gap: 10 }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Message Clinical Assistant" style={{ flex: 1, padding: "12px 14px", borderRadius: 10, border: "1px solid var(--border)", background: "#0b1220", color: "var(--text)" }} />
            <button type="submit" disabled={!canSend} style={{ padding: "12px 16px", borderRadius: 10, border: "1px solid var(--border)", background: canSend ? "var(--accent)" : "#0b1220", color: "var(--text)", cursor: canSend ? "pointer" : "not-allowed" }}>
              Send
            </button>
          </form>
        </footer>
      </main>
    </div>
  );
}
