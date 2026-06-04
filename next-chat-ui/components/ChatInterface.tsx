"use client";

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

type Role = "user" | "assistant";

type Msg = {
  id: string;
  role: Role;
  text: string;
  createdAt: number;
};

type ChatThread = {
  id: string;
  title: string;
  messages: Msg[];
  sessionId: string;
  updatedAt: number;
};

type StoredChatSession = {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  messages: {
    id: number;
    role: Role;
    message: string;
    createdAt: string;
  }[];
};

type AuthUser = {
  id: number;
  phone: string;
  createdAt?: string;
};

const STORAGE_KEY = "radiantmedai_threads_v1";
const LEGACY_STORAGE_KEY = "medassistant_threads_v2";
const THEME_KEY = "radiantmedai_theme";
const AUTH_USER_KEY = "radiantmedai_auth_user";
const EMPTY_RESPONSE = "No clinical response generated.";
const TYPE_WORDS_PER_TICK = 1;
const TYPE_TICK_MS = 125;
const MAX_SAVED_CHAT_SESSIONS = 5;

function makeId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

function createThread(): ChatThread {
  return {
    id: makeId("thread"),
    title: "New chat",
    messages: [],
    sessionId: makeId("session"),
    updatedAt: Date.now(),
  };
}

function makeTitle(text: string) {
  const cleaned = text.trim().replace(/\s+/g, " ");
  return cleaned.length > 42 ? `${cleaned.slice(0, 42)}...` : cleaned || "New chat";
}

function tryJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pickText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = pickText(item);
      if (text) return text;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";

  const record = value as Record<string, unknown>;
  const candidates = [
    record.output,
    record.text,
    record.response,
    record.details,
    record.message,
    record.content,
    record.data,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    if (candidate && typeof candidate === "object") {
      const nested = pickText(candidate);
      if (nested) return nested;
    }
  }

  return "";
}

function cleanAssistantText(text: string) {
  const parsed = tryJson(text.trim());
  const extracted = parsed ? pickText(parsed) : "";
  const source = extracted || text;

  return source
    .replace(/\\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitForTyping(text: string) {
  return text.match(/\S+\s*/g) || [text];
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function loadThreads(): ChatThread[] {
  if (typeof window === "undefined") return [createThread()];

  const saved = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!saved) return [createThread()];

  try {
    const parsed = JSON.parse(saved) as ChatThread[];
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    return [createThread()];
  }

  return [createThread()];
}

function threadsFromStoredSessions(sessions: StoredChatSession[]) {
  return sessions.map((session) => {
    const firstQuestion = session.messages.find((message) => message.role === "user")?.message || "";

    return {
      id: session.sessionId,
      sessionId: session.sessionId,
      title: makeTitle(firstQuestion),
      updatedAt: new Date(session.updatedAt).getTime(),
      messages: session.messages.map((message) => ({
        id: `db_${message.id}`,
        role: message.role,
        text: message.message,
        createdAt: new Date(message.createdAt).getTime(),
      })),
    };
  });
}

function normalizePhone(phone: string) {
  return phone.replace(/[^\d+]/g, "").trim();
}

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

function MenuIcon() {
  return (
    <Icon>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </Icon>
  );
}

function PlusIcon() {
  return (
    <Icon>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Icon>
  );
}

function PencilIcon() {
  return (
    <Icon>
      <path d="M4 20h4.2L19.5 8.7a2 2 0 0 0 0-2.8l-1.4-1.4a2 2 0 0 0-2.8 0L4 15.8V20Z" />
      <path d="m14 6 4 4" />
    </Icon>
  );
}

function CopyIcon() {
  return (
    <Icon>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M4 16V6a2 2 0 0 1 2-2h10" />
    </Icon>
  );
}

function TrashIcon() {
  return (
    <Icon>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M6 6l1 16h10l1-16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </Icon>
  );
}

function StopIcon() {
  return (
    <Icon>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
    </Icon>
  );
}

function SendIcon() {
  return (
    <Icon>
      <path d="m5 12 14-7-7 14-2-7-5-2Z" />
      <path d="m10 12 9-7" />
    </Icon>
  );
}

function ThemeIcon() {
  return (
    <Icon>
      <path d="M12 3v2" />
      <path d="M12 19v2" />
      <path d="M4.2 4.2l1.4 1.4" />
      <path d="M18.4 18.4l1.4 1.4" />
      <path d="M3 12h2" />
      <path d="M19 12h2" />
      <path d="M4.2 19.8l1.4-1.4" />
      <path d="M18.4 5.6l1.4-1.4" />
      <circle cx="12" cy="12" r="4" />
    </Icon>
  );
}

function HistoryIcon() {
  return (
    <Icon>
      <path d="M4 12a8 8 0 1 0 2.4-5.7" />
      <path d="M4 4v5h5" />
      <path d="M12 7v5l3 2" />
    </Icon>
  );
}

function HelpIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9a2.6 2.6 0 0 1 5 1c0 2-2.6 2-2.6 4" />
      <path d="M12 17h.01" />
    </Icon>
  );
}

function GridIcon() {
  return (
    <Icon>
      <circle cx="6" cy="6" r="1" />
      <circle cx="12" cy="6" r="1" />
      <circle cx="18" cy="6" r="1" />
      <circle cx="6" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="18" cy="12" r="1" />
      <circle cx="6" cy="18" r="1" />
      <circle cx="12" cy="18" r="1" />
      <circle cx="18" cy="18" r="1" />
    </Icon>
  );
}

function RadiantLogo() {
  return (
    <img
      src="/images/radiant-hospitals-logo.png"
      alt="RadiantMedAI"
      className="radiant-logo"
    />
  );
}

export default function ChatInterface() {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState("");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("light");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [historyLimitOpen, setHistoryLimitOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);

  useEffect(() => {
    const initialThreads = loadThreads();
    setThreads(initialThreads);
    setActiveThreadId(initialThreads[0].id);

    const savedTheme = localStorage.getItem(THEME_KEY);
    const nextTheme = savedTheme === "dark" ? "dark" : "light";
    const savedUser = localStorage.getItem(AUTH_USER_KEY);
    setTheme(nextTheme);
    document.documentElement.setAttribute("data-theme", nextTheme);

    if (savedUser) {
      try {
        setAuthUser(JSON.parse(savedUser) as AuthUser);
      } catch {
        localStorage.removeItem(AUTH_USER_KEY);
      }
    }
  }, []);

  useEffect(() => {
    if (!authUser) return;
    void loadDatabaseThreads(authUser.id, activeThreadId || threads[0]?.id || "");
  }, [authUser]);

  useEffect(() => {
    if (!threads.length) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(threads));
  }, [threads]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [threads, activeThreadId, streamingId]);

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) || threads[0],
    [threads, activeThreadId],
  );

  const sortedThreads = useMemo(
    () => threads.slice().sort((a, b) => b.updatedAt - a.updatedAt),
    [threads],
  );
  const savedThreadCount = useMemo(
    () => threads.filter((thread) => thread.messages.length > 0).length,
    [threads],
  );

  const canSend = input.trim().length > 0 && !loading && !!activeThread;
  const displayPhone = authUser?.phone || "";
  const userInitial = displayPhone.replace(/\D/g, "").slice(-1) || "D";

  function updateThread(threadId: string, updater: (thread: ChatThread) => ChatThread) {
    setThreads((prev) => prev.map((thread) => (thread.id === threadId ? updater(thread) : thread)));
  }

  async function loadDatabaseThreads(userId: number, fallbackThreadId: string) {
    try {
      const res = await fetch(`/api/chat/history?userId=${encodeURIComponent(userId)}`);
      if (!res.ok) return;

      const data = (await res.json()) as { sessions?: StoredChatSession[] };
      if (!data.sessions?.length) return;

      const databaseThreads = threadsFromStoredSessions(data.sessions);
      setThreads(databaseThreads);
      setActiveThreadId(databaseThreads[0]?.id || fallbackThreadId);
    } catch {
      return;
    }
  }

  function updateMessage(threadId: string, messageId: string, text: string) {
    updateThread(threadId, (thread) => ({
      ...thread,
      messages: thread.messages.map((message) =>
        message.id === messageId ? { ...message, text } : message,
      ),
      updatedAt: Date.now(),
    }));
  }

  async function typeAssistantText(threadId: string, messageId: string, text: string) {
    const cleaned = cleanAssistantText(text) || EMPTY_RESPONSE;
    const parts = splitForTyping(cleaned);
    let visible = "";

    for (let index = 0; index < parts.length; index += TYPE_WORDS_PER_TICK) {
      if (stopRequestedRef.current) return;
      visible += parts.slice(index, index + TYPE_WORDS_PER_TICK).join("");
      updateMessage(threadId, messageId, visible);
      await sleep(TYPE_TICK_MS);
    }

    if (!stopRequestedRef.current) {
      updateMessage(threadId, messageId, cleaned);
    }
  }

  function startNewChat() {
    if (authUser && savedThreadCount >= MAX_SAVED_CHAT_SESSIONS) {
      setHistoryLimitOpen(true);
      return;
    }

    const thread = createThread();
    setThreads((prev) => [thread, ...prev]);
    setActiveThreadId(thread.id);
    setInput("");
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function clearCurrentChat() {
    if (!activeThread) return;
    updateThread(activeThread.id, (thread) => ({
      ...thread,
      messages: [],
      title: "New chat",
      sessionId: makeId("session"),
      updatedAt: Date.now(),
    }));
  }

  async function deleteThread(thread: ChatThread) {
    if (!authUser) return;

    try {
      const res = await fetch("/api/chat/history", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: thread.sessionId, userId: authUser.id }),
      });

      if (!res.ok) return;
    } catch {
      return;
    }

    const remaining = threads.filter((item) => item.id !== thread.id);
    const nextThreads = remaining.length ? remaining : [createThread()];

    setThreads(nextThreads);
    if (activeThreadId === thread.id) {
      setActiveThreadId(nextThreads[0].id);
    }
  }

  async function deleteAllHistory() {
    if (!authUser) return;

    try {
      const res = await fetch("/api/chat/history", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteAll: true, userId: authUser.id }),
      });

      if (!res.ok) return;
    } catch {
      return;
    }

    const thread = createThread();
    setThreads([thread]);
    setActiveThreadId(thread.id);
    setHistoryLimitOpen(false);
    setInput("");
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  async function copyQuestion(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setInput(text);
    }
  }

  function startInlineEdit(message: Msg) {
    setEditingMessageId(message.id);
    setEditingText(message.text);
  }

  function cancelInlineEdit() {
    setEditingMessageId(null);
    setEditingText("");
  }

  function saveInlineEdit(threadId: string, messageId: string) {
    const nextText = editingText.trim();
    if (!nextText) return;
    updateMessage(threadId, messageId, nextText);
    cancelInlineEdit();
  }

  function stopResponse() {
    stopRequestedRef.current = true;
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setStreamingId(null);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function signOut() {
    void fetch("/api/auth/logout", { method: "POST" });
    localStorage.removeItem(AUTH_USER_KEY);
    setAuthUser(null);
    const thread = createThread();
    setThreads([thread]);
    setActiveThreadId(thread.id);
  }

  async function onAuthSubmit(e: FormEvent) {
    e.preventDefault();
    setAuthError("");

    const normalizedPhone = normalizePhone(phone);
    if (normalizedPhone.length < 7) {
      setAuthError("Enter a valid phone number.");
      return;
    }

    if (password.length < 6) {
      setAuthError("Password must be at least 6 characters.");
      return;
    }

    const res = await fetch(authMode === "login" ? "/api/auth/login" : "/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: normalizedPhone, password }),
    });

    const data = (await res.json().catch(() => ({}))) as { user?: AuthUser; message?: string };
    if (!res.ok || !data.user) {
      setAuthError(data.message || "Authentication failed.");
      return;
    }

    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(data.user));
    setAuthUser(data.user);
    setAuthOpen(false);
    setPassword("");
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  async function readStreamingResponse(res: Response, threadId: string, assistantId: string) {
    if (!res.body) {
      const text = cleanAssistantText(await res.text()) || EMPTY_RESPONSE;
      await typeAssistantText(threadId, assistantId, text);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let assembled = "";

    while (true) {
      if (stopRequestedRef.current) {
        await reader.cancel();
        return;
      }

      const { done, value } = await reader.read();
      if (done) break;

      assembled += decoder.decode(value, { stream: true });
      updateMessage(threadId, assistantId, cleanAssistantText(assembled));
    }

    await typeAssistantText(threadId, assistantId, cleanAssistantText(assembled) || EMPTY_RESPONSE);
  }

  async function onSubmit(e?: FormEvent) {
    e?.preventDefault();
    if (!canSend || !activeThread) return;

    if (!authUser) {
      setAuthMode("login");
      setAuthOpen(true);
      return;
    }

    if (activeThread.messages.length === 0 && savedThreadCount >= MAX_SAVED_CHAT_SESSIONS) {
      setHistoryLimitOpen(true);
      return;
    }

    const question = input.trim();
    const threadId = activeThread.id;
    const assistantId = makeId("assistant");
    const now = Date.now();

    setInput("");
    setLoading(true);
    setStreamingId(assistantId);
    stopRequestedRef.current = false;
    const abortController = new AbortController();
    abortRef.current = abortController;

    updateThread(threadId, (thread) => ({
      ...thread,
      title: thread.messages.length === 0 ? makeTitle(question) : thread.title,
      messages: [
        ...thread.messages,
        { id: makeId("user"), role: "user", text: question, createdAt: now },
        { id: assistantId, role: "assistant", text: "", createdAt: now + 1 },
      ],
      updatedAt: now,
    }));

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        signal: abortController.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatInput: question,
          sessionId: activeThread.sessionId,
          userId: authUser.id,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        if (res.status === 409) setHistoryLimitOpen(true);
        await typeAssistantText(threadId, assistantId, text || "Unable to reach the clinical workflow.");
        return;
      }

      await readStreamingResponse(res, threadId, assistantId);
    } catch (error) {
      if (stopRequestedRef.current || (error instanceof DOMException && error.name === "AbortError")) {
        return;
      }

      await typeAssistantText(threadId, assistantId, "Unable to reach the clinical workflow.");
    } finally {
      if (abortRef.current === abortController) {
        abortRef.current = null;
      }
      if (!stopRequestedRef.current) {
        setLoading(false);
        setStreamingId(null);
      }
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  function onComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onSubmit();
    }
  }

  if (!activeThread) {
    return <div className="boot-screen">Loading RadiantMedAI...</div>;
  }

  return (
    <div className={`radiant-shell ${sidebarOpen ? "sidebar-open" : "sidebar-closed"}`}>
      <aside className="rail">
        <button
          type="button"
          className="rail-button"
          aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          onClick={() => setSidebarOpen((prev) => !prev)}
        >
          <MenuIcon />
        </button>

        <button type="button" className="rail-button rail-primary" aria-label="New chat" title="New chat" onClick={startNewChat}>
          <PlusIcon />
        </button>

        <div className="rail-spacer" />

        <button type="button" className="rail-button" aria-label="Chat history" title="Chat history" onClick={() => setSidebarOpen(true)}>
          <HistoryIcon />
        </button>
        <button type="button" className="rail-button" aria-label="Help" title="Help">
          <HelpIcon />
        </button>
        <button
          type="button"
          className="rail-button"
          aria-label={theme === "dark" ? "Use light mode" : "Use dark mode"}
          title={theme === "dark" ? "Light mode" : "Dark mode"}
          onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
        >
          <ThemeIcon />
        </button>
      </aside>

      <AnimatePresence>
        {sidebarOpen ? (
          <motion.aside
            className="drawer"
            aria-hidden={!sidebarOpen}
            initial={{ x: -28, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -28, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            <div className="drawer-brand">
              <RadiantLogo />
              <div>
                <div className="brand-title">RadiantMedAI</div>
                <div className="brand-caption">Internal clinical guideline chat</div>
              </div>
            </div>

            <button type="button" className="drawer-new" onClick={startNewChat}>
              <PlusIcon />
              <span>New consultation</span>
            </button>

            <div className="drawer-section-title">Recent chats</div>
            <div className="thread-list">
              {sortedThreads.map((thread) => (
                <div key={thread.id} className={`thread-item ${thread.id === activeThread.id ? "is-active" : ""}`}>
                  <button
                    type="button"
                    className="thread-select"
                    onClick={() => {
                      setActiveThreadId(thread.id);
                      if (window.innerWidth < 900) setSidebarOpen(false);
                    }}
                  >
                    <span>{thread.title}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-button thread-delete"
                    aria-label={`Delete ${thread.title}`}
                    title="Delete chat"
                    onClick={() => void deleteThread(thread)}
                  >
                    <TrashIcon />
                  </button>
                </div>
              ))}
            </div>

            <div className="drawer-footer">
              <button type="button" className="drawer-link" onClick={() => setHistoryLimitOpen(true)}>
                Delete all history
              </button>
              <button type="button" className="drawer-link" onClick={clearCurrentChat}>
                Reset current session
              </button>
              {authUser ? (
                <button type="button" className="drawer-link" onClick={signOut}>
                  Sign out {displayPhone}
                </button>
              ) : (
                <button type="button" className="drawer-link" onClick={() => setAuthOpen(true)}>
                  Sign in
                </button>
              )}
            </div>
          </motion.aside>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {sidebarOpen ? (
          <motion.button
            type="button"
            className="drawer-scrim"
            aria-label="Close sidebar"
            onClick={() => setSidebarOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
          />
        ) : null}
      </AnimatePresence>

      <main className={`chat-main ${activeThread.messages.length === 0 ? "is-empty" : "has-messages"}`}>
        <header className="chat-topbar">
          <div className="topbar-title">
            <span>RadiantMedAI</span>
          </div>
          <div className="topbar-actions">
            <button type="button" className="topbar-icon" aria-label="Applications" title="Applications">
              <GridIcon />
            </button>
            <button
              type="button"
              className="user-chip"
              onClick={() => (authUser ? signOut() : setAuthOpen(true))}
              title={authUser ? "Sign out" : "Sign in"}
            >
              {authUser ? userInitial : "DR"}
            </button>
          </div>
        </header>

        <section ref={scrollRef} className="conversation-panel">
          {activeThread.messages.length === 0 ? (
            <motion.div
              className="welcome-panel"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28, ease: "easeOut" }}
            >
              <h1>
                <span>Hello, Doctor</span>
                <strong>How can I help with this case today?</strong>
              </h1>
            </motion.div>
          ) : (
            <div className="message-stack">
              {activeThread.messages.map((message) => {
                const isStreaming = message.id === streamingId;
                return (
                  <motion.article
                    key={message.id}
                    className={`message-row ${message.role}`}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div className="avatar">{message.role === "user" ? "DR" : "R"}</div>
                    <div className="message-body">
                      <div className="message-meta">
                        <span>{message.role === "user" ? "Doctor" : "RadiantMedAI"}</span>
                        {message.role === "user" ? (
                          <span className="message-actions">
                            <button
                              type="button"
                              className="icon-button"
                              aria-label="Edit question"
                              title="Edit question"
                              onClick={() => startInlineEdit(message)}
                            >
                              <PencilIcon />
                            </button>
                            <button
                              type="button"
                              className="icon-button"
                              aria-label="Copy question"
                              title="Copy question"
                              onClick={() => void copyQuestion(message.text)}
                            >
                              <CopyIcon />
                            </button>
                          </span>
                        ) : null}
                      </div>
                      {editingMessageId === message.id ? (
                        <div className="inline-edit">
                          <textarea
                            value={editingText}
                            onChange={(e) => setEditingText(e.target.value)}
                            autoFocus
                            rows={2}
                          />
                          <div className="inline-edit-actions">
                            <button type="button" onClick={() => saveInlineEdit(activeThread.id, message.id)}>
                              Save
                            </button>
                            <button type="button" className="ghost" onClick={cancelInlineEdit}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className={`message-text ${isStreaming && message.text ? "is-typing" : ""}`}>
                          {message.text ||
                            (isStreaming ? (
                              <span className="typing-dots" aria-label="RadiantMedAI is thinking">
                                <span />
                                <span />
                                <span />
                              </span>
                            ) : (
                              ""
                            ))}
                        </div>
                      )}
                    </div>
                  </motion.article>
                );
              })}
            </div>
          )}
        </section>

        <section className="composer-panel">
          <form onSubmit={onSubmit} className="composer">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder="Enter a clinical prompt here"
              rows={1}
            />
            {loading ? (
              <button
                type="button"
                className="composer-button stop-button"
                aria-label="Stop response"
                title="Stop response"
                onClick={stopResponse}
              >
                <StopIcon />
              </button>
            ) : (
              <button type="submit" className="composer-button" disabled={!canSend} aria-label="Send message">
                <SendIcon />
              </button>
            )}
          </form>
          <div className="composer-hint">
            RadiantMedAI only uses internal approved and updated clinical guideline for specific clinical conditions. For other conditions not in this guideline, verify with a qualified clinician.
          </div>
        </section>
      </main>

      <AnimatePresence>
        {authOpen ? (
          <motion.div
            className="auth-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-title"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
          <motion.form
            className="auth-card"
            onSubmit={onAuthSubmit}
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            <button type="button" className="auth-close" aria-label="Close login" onClick={() => setAuthOpen(false)}>
              x
            </button>
            <div className="auth-brand">
                <RadiantLogo />
                <div>
                  <h2 id="auth-title">{authMode === "login" ? "Sign in to chat" : "Create access"}</h2>
                <p>Phone and password authentication is stored in PostgreSQL.</p>
              </div>
            </div>

            <label>
              Phone number
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+254..."
                inputMode="tel"
                autoComplete="tel"
              />
            </label>
            <label>
              Password
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimum 6 characters"
                type="password"
                autoComplete={authMode === "login" ? "current-password" : "new-password"}
              />
            </label>

            {authError ? <div className="auth-error">{authError}</div> : null}

            <button type="submit" className="auth-submit">
              {authMode === "login" ? "Sign in and continue" : "Register and continue"}
            </button>

            <button
              type="button"
              className="auth-switch"
              onClick={() => {
                setAuthMode((prev) => (prev === "login" ? "register" : "login"));
                setAuthError("");
              }}
            >
              {authMode === "login" ? "Need an account? Register" : "Already registered? Sign in"}
            </button>
          </motion.form>
        </motion.div>
      ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {historyLimitOpen ? (
          <motion.div
            className="auth-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-limit-title"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="auth-card history-limit-card"
              initial={{ opacity: 0, y: 18, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              <button type="button" className="auth-close" aria-label="Close history prompt" onClick={() => setHistoryLimitOpen(false)}>
                x
              </button>
              <div className="auth-brand">
                <RadiantLogo />
                <div>
                  <h2 id="history-limit-title">Chat history limit reached</h2>
                  <p>You can keep up to {MAX_SAVED_CHAT_SESSIONS} saved consultations. Delete all chat history to start a new consultation and keep the database from filling up.</p>
                </div>
              </div>
              <div className="history-limit-actions">
                <button type="button" className="auth-submit danger" onClick={() => void deleteAllHistory()}>
                  Delete all chat history
                </button>
                <button type="button" className="auth-secondary" onClick={() => setHistoryLimitOpen(false)}>
                  Cancel
                </button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
