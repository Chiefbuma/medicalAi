"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Role = "user" | "assistant";

type Msg = {
  id: string;
  role: Role;
  text: string;
};

type ChatThread = {
  id: string;
  title: string;
  messages: Msg[];
  sessionId: string;
  updatedAt: number;
};

const STRICT_DOC_FALLBACK =
  "I don’t have enough evidence in the provided document to answer that safely.";

function makeId() {
  return Math.random().toString(36).slice(2);
}

function getSessionId(): string {
  if (typeof window === "undefined") {
    return `session_${Math.random().toString(36).slice(2)}`;
  }
  const key = "clinical_chat_session_id";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const created = `session_${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(key, created);
  return created;
}

function parseStreamLine(line: string): { type?: string; content?: string } | null {
  try {
    const parsed = JSON.parse(line) as { type?: string; content?: unknown };
    return {
      type: parsed.type,
      content: typeof parsed.content === "string" ? parsed.content : undefined,
    };
  } catch {
    return null;
  }
}

function makeTitleFromQuestion(q: string): string {
  const short = q.trim().replace(/\s+/g, " ");
  return short.length > 48 ? `${short.slice(0, 48)}...` : short;
}

function isToolCallLeak(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  if (/^\{\s*"name"\s*:\s*"/.test(trimmed) && /"parameters"\s*:/.test(trimmed)) {
    return true;
  }

  try {
    const parsed = JSON.parse(trimmed) as { name?: unknown; parameters?: unknown };
    return typeof parsed.name === "string" && typeof parsed.parameters === "object";
  } catch {
    return false;
  }
}

function sanitizeAssistantText(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isToolCallLeak(line));

  const rebuilt = lines.join("\n").trim();
  return isToolCallLeak(rebuilt) ? "" : rebuilt;
}

export default function ChatInterface() {
  const [threads, setThreads] = useState<ChatThread[]>(() => {
    const first: ChatThread = {
      id: makeId(),
      title: "New session",
      messages: [],
      sessionId: getSessionId(),
      updatedAt: Date.now(),
    };
    return [first];
  });
  const [activeThreadId, setActiveThreadId] = useState<string>(threads[0].id);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [thinkingDots, setThinkingDots] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authName, setAuthName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId) || threads[0],
    [threads, activeThreadId],
  );

  const canSend = useMemo(() => input.trim().length > 0 && !loading, [input, loading]);

  useEffect(() => {
    const savedTheme = localStorage.getItem("medassistant_theme");
    if (savedTheme === "light" || savedTheme === "dark") {
      setTheme(savedTheme);
      document.documentElement.setAttribute("data-theme", savedTheme);
    } else {
      document.documentElement.setAttribute("data-theme", "dark");
    }

    const token = localStorage.getItem("medassistant_auth_token");
    const name = localStorage.getItem("medassistant_auth_name") || "";
    if (token) {
      setIsAuthenticated(true);
      setAuthName(name || "User");
    }
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("medassistant_theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!loading) {
      setThinkingDots("");
      return;
    }
    const seq = [".", "..", "..."];
    let idx = 0;
    const t = setInterval(() => {
      setThinkingDots(seq[idx % seq.length]);
      idx += 1;
    }, 350);
    return () => clearInterval(t);
  }, [loading]);

  function updateActiveMessages(mutator: (messages: Msg[]) => Msg[]) {
    setThreads((prev) =>
      prev.map((t) =>
        t.id === activeThread.id
          ? { ...t, messages: mutator(t.messages), updatedAt: Date.now() }
          : t,
      ),
    );
  }

  function setActiveTitle(title: string) {
    setThreads((prev) =>
      prev.map((t) => (t.id === activeThread.id ? { ...t, title, updatedAt: Date.now() } : t)),
    );
  }

  function updateMessageText(id: string, text: string) {
    updateActiveMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text } : m)));
  }

  function startNewChat() {
    const thread: ChatThread = {
      id: makeId(),
      title: "New session",
      messages: [],
      sessionId: getSessionId(),
      updatedAt: Date.now(),
    };
    setThreads((prev) => [thread, ...prev]);
    setActiveThreadId(thread.id);
    setInput("");
    setEditingMessageId(null);
  }

  function onEditMessage(messageId: string) {
    const target = activeThread.messages.find((m) => m.id === messageId && m.role === "user");
    if (!target) return;
    setInput(target.text);
    setEditingMessageId(messageId);
  }

  function onSignOut() {
    localStorage.removeItem("medassistant_auth_token");
    localStorage.removeItem("medassistant_auth_name");
    setIsAuthenticated(false);
    setAuthName("");
    setEmail("");
    setPassword("");
  }

  function onAuthenticate(e: FormEvent) {
    e.preventDefault();
    const cleanedEmail = email.trim().toLowerCase();
    if (!cleanedEmail || !password.trim()) {
      setAuthError("Enter both email and password.");
      return;
    }

    const nameFromEmail = cleanedEmail.split("@")[0] || "User";
    const normalizedName = nameFromEmail.charAt(0).toUpperCase() + nameFromEmail.slice(1);
    const token = `medassistant_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    localStorage.setItem("medassistant_auth_token", token);
    localStorage.setItem("medassistant_auth_name", normalizedName);

    setAuthName(normalizedName);
    setAuthError("");
    setIsAuthenticated(true);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q) return;

    setInput("");

    let assistantId = makeId();

    if (editingMessageId) {
      updateActiveMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === editingMessageId);
        if (idx < 0) return prev;
        const updated = [...prev];
        updated[idx] = { ...updated[idx], text: q };
        return [...updated.slice(0, idx + 1), { id: assistantId, role: "assistant", text: "" }];
      });
      setEditingMessageId(null);
    } else {
      updateActiveMessages((prev) => [
        ...prev,
        { id: makeId(), role: "user", text: q },
        { id: assistantId, role: "assistant", text: "" },
      ]);
    }

    if (activeThread.title === "New session") {
      setActiveTitle(makeTitleFromQuestion(q));
    }

    setStreamingId(assistantId);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatInput: q, sessionId: activeThread.sessionId }),
      });

      if (!res.ok) {
        const errText = await res.text();
        updateMessageText(assistantId, errText || "Unable to reach the assistant right now.");
        return;
      }

      if (!res.body) {
        const txt = await res.text();
        updateMessageText(assistantId, txt || "No response from assistant.");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assembled = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;

          const evt = parseStreamLine(line);
          if (evt?.type === "item" && evt.content) {
            assembled += evt.content;
            const sanitized = sanitizeAssistantText(assembled);
            if (sanitized) updateMessageText(assistantId, sanitized);
            continue;
          }

          if (!evt) {
            assembled += line;
            const sanitized = sanitizeAssistantText(assembled);
            if (sanitized) updateMessageText(assistantId, sanitized);
          }
        }
      }

      if (!assembled.trim()) {
        const tail = buffer.trim();
        if (tail) {
          const evt = parseStreamLine(tail);
          if (evt?.type === "item" && evt.content) {
            assembled += evt.content;
          } else if (!evt) {
            assembled += tail;
          }
        }
      }

      const finalText = sanitizeAssistantText(assembled) || STRICT_DOC_FALLBACK;
      updateMessageText(assistantId, finalText);
    } catch {
      updateMessageText(assistantId, "Unable to reach the assistant right now.");
    } finally {
      setLoading(false);
      setStreamingId(null);
    }
  }

  if (!isAuthenticated) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <div className="brand-row">
            <div className="brand-logo">MA</div>
            <div>
              <h1>MedAssistant</h1>
              <p>Sign in to continue</p>
            </div>
          </div>

          <form onSubmit={onAuthenticate} className="auth-form">
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
              />
            </label>
            {authError && <div className="auth-error">{authError}</div>}
            <button type="submit">Sign In</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-row">
          <div className="brand-logo">MA</div>
          <div className="brand-text">MedAssistant</div>
        </div>

        <div className="header-actions">
          <button
            type="button"
            className="ghost-btn"
            onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
          >
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
          <span className="user-pill">{authName}</span>
          <button type="button" className="ghost-btn" onClick={onSignOut}>
            Sign Out
          </button>
        </div>
      </header>

      <div className="app-layout">
        <aside className={`sidebar ${historyCollapsed ? "is-collapsed" : ""}`}>
          <div className="sidebar-top">
            {!historyCollapsed && <h2>Chats</h2>}
            <button
              type="button"
              className="toggle-btn"
              onClick={() => setHistoryCollapsed((prev) => !prev)}
            >
              {historyCollapsed ? ">" : "<"}
            </button>
          </div>

          {!historyCollapsed && (
            <>
              <button type="button" className="new-chat-btn" onClick={startNewChat}>
                + New Chat
              </button>
              <div className="sidebar-list">
                {threads
                  .slice()
                  .sort((a, b) => b.updatedAt - a.updatedAt)
                  .map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setActiveThreadId(t.id)}
                      className={`thread-item ${t.id === activeThread.id ? "is-active" : ""}`}
                    >
                      {t.title}
                    </button>
                  ))}
              </div>
            </>
          )}
        </aside>

        <main className="main-content">
          <div className="hero-subtitle">Hello, Am MedAssistant</div>

          <section className="chat-window">
            <div className="messages">
              {activeThread.messages.length === 0 && (
                <div className="empty-state">Start chatting below.</div>
              )}
              {activeThread.messages.map((m) => {
                const isStreaming = loading && streamingId === m.id;
                return (
                  <div key={m.id} className={`msg-row ${m.role === "user" ? "is-user" : "is-assistant"}`}>
                    <div className="msg-card">
                      <div className="msg-text">{m.text || (isStreaming ? `Thinking${thinkingDots}` : "")}</div>
                      {m.role === "user" && !loading && (
                        <button className="edit-btn" onClick={() => onEditMessage(m.id)}>
                          Edit
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="composer-shell">
            <form onSubmit={onSubmit} className="composer-form">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={editingMessageId ? "Edit your query and press Enter" : "Ask MedAssistant anything..."}
                className="composer-input"
              />

              <div className="composer-actions">
                <span>Default permissions</span>
                <button type="submit" disabled={!canSend} className="send-btn">
                  ^
                </button>
              </div>
            </form>
          </section>
        </main>
      </div>
    </div>
  );
}
