"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

type AdminUser = {
  id: number;
  phone: string;
  isAdmin: boolean;
  createdAt: string;
  updatedAt?: string;
  chatCount: number;
};

type ModelSettings = {
  provider: "ollama" | "openai" | "deepseek";
  model: string;
  updatedAt?: string;
};

type ModelOption = {
  id: number;
  provider: ModelSettings["provider"];
  model: string;
  createdAt: string;
  updatedAt: string;
};

type AuthUser = {
  id: number;
  phone: string;
  isAdmin: boolean;
};

type AdminSection = "users" | "models";

type UserForm = {
  id?: number;
  phone: string;
  password: string;
  isAdmin: boolean;
};

type ModelForm = {
  id?: number;
  provider: ModelSettings["provider"];
  model: string;
};

const AUTH_USER_KEY = "radiantmedai_auth_user";
const THEME_KEY = "radiantmedai_theme";
const PAGE_SIZE = 8;

function normalizePhone(phone: string) {
  return phone.replace(/[^\d+]/g, "").trim();
}

function RadiantLogo() {
  return <img src="/images/radiant-hospitals-logo.png" alt="RadiantMedAI" className="radiant-logo" />;
}

function formatDate(value?: string) {
  if (!value) return "-";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export default function AdminPanel() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [phone, setPhone] = useState("+254700000000");
  const [password, setPassword] = useState("Admin@12345");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [settings, setSettings] = useState<ModelSettings>({ provider: "ollama", model: "phi4-mini:3.8b" });
  const [modelOptions, setModelOptions] = useState<Record<string, string[]>>({});
  const [modelOptionsList, setModelOptionsList] = useState<ModelOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState<AdminSection>("users");
  const [theme, setTheme] = useState<"dark" | "light">("light");
  const [userSearch, setUserSearch] = useState("");
  const [userPage, setUserPage] = useState(1);
  const [modelSearch, setModelSearch] = useState("");
  const [modelPage, setModelPage] = useState(1);
  const [userFormOpen, setUserFormOpen] = useState(false);
  const [userForm, setUserForm] = useState<UserForm>({ phone: "", password: "", isAdmin: false });
  const [modelFormOpen, setModelFormOpen] = useState(false);
  const [modelForm, setModelForm] = useState<ModelForm>({ provider: "ollama", model: "" });

  useEffect(() => {
    const savedTheme = localStorage.getItem(THEME_KEY);
    const nextTheme = savedTheme === "dark" ? "dark" : "light";
    setTheme(nextTheme);
    document.documentElement.setAttribute("data-theme", nextTheme);

    const saved = localStorage.getItem(AUTH_USER_KEY);
    if (saved) {
      try {
        const user = JSON.parse(saved) as AuthUser;
        setAuthUser(user);
        if (user.isAdmin) void loadAdminData();
      } catch {
        localStorage.removeItem(AUTH_USER_KEY);
      }
    }
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  async function loadAdminData() {
    const [usersRes, modelRes] = await Promise.all([
      fetch("/api/admin/users"),
      fetch("/api/admin/model"),
    ]);

    if (usersRes.status === 403 || modelRes.status === 403) {
      setError("Admin access required. Sign in with an admin account.");
      return;
    }

    if (usersRes.ok) {
      const data = (await usersRes.json()) as { users?: AdminUser[] };
      setUsers(data.users || []);
    }

    if (modelRes.ok) {
      const data = (await modelRes.json()) as {
        settings?: ModelSettings;
        options?: Record<string, string[]>;
        modelOptions?: ModelOption[];
      };
      if (data.settings) setSettings(data.settings);
      if (data.options) setModelOptions(data.options);
      if (data.modelOptions) setModelOptionsList(data.modelOptions);
    }
  }

  async function onLogin(e: FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: normalizePhone(phone), password }),
    });
    const data = (await res.json().catch(() => ({}))) as { user?: AuthUser; message?: string };

    if (!res.ok || !data.user) {
      setError(data.message || "Unable to sign in.");
      return;
    }

    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(data.user));
    setAuthUser(data.user);
    if (!data.user.isAdmin) {
      setError("This account is not an admin.");
      return;
    }
    await loadAdminData();
  }

  function signOut() {
    localStorage.removeItem(AUTH_USER_KEY);
    setAuthUser(null);
    void fetch("/api/auth/logout", { method: "POST" });
  }

  function openCreateUser() {
    setUserForm({ phone: "", password: "", isAdmin: false });
    setUserFormOpen(true);
  }

  function openEditUser(user: AdminUser) {
    setUserForm({ id: user.id, phone: user.phone, password: "", isAdmin: user.isAdmin });
    setUserFormOpen(true);
  }

  async function saveUser(e: FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    const isEdit = Boolean(userForm.id);
    const body = {
      userId: userForm.id,
      phone: normalizePhone(userForm.phone),
      password: userForm.password,
      isAdmin: userForm.isAdmin,
    };

    const res = await fetch("/api/admin/users", {
      method: isEdit ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string };

    if (!res.ok) {
      setError(data.message || "Unable to save user.");
      return;
    }

    setUserFormOpen(false);
    setNotice(isEdit ? "User updated." : "User created.");
    await loadAdminData();
  }

  async function toggleUserAdmin(user: AdminUser) {
    setError("");
    const res = await fetch("/api/admin/users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id, isAdmin: !user.isAdmin }),
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) {
      setError(data.message || "Unable to update user.");
      return;
    }
    await loadAdminData();
  }

  async function deleteUser(user: AdminUser) {
    if (!window.confirm(`Delete ${user.phone}? This also deletes their chat history.`)) return;
    setError("");
    const res = await fetch("/api/admin/users", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id }),
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) {
      setError(data.message || "Unable to delete user.");
      return;
    }
    setNotice("User deleted.");
    await loadAdminData();
  }

  async function saveModel(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    const res = await fetch("/api/admin/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    const data = (await res.json().catch(() => ({}))) as { settings?: ModelSettings; message?: string };
    setSaving(false);

    if (!res.ok || !data.settings) {
      setError(data.message || "Unable to save model settings.");
      return;
    }

    setSettings(data.settings);
    setNotice("Active model updated.");
  }

  function openCreateModel() {
    setModelForm({ provider: "ollama", model: "" });
    setModelFormOpen(true);
  }

  function openEditModel(option: ModelOption) {
    setModelForm({ id: option.id, provider: option.provider, model: option.model });
    setModelFormOpen(true);
  }

  async function saveModelOption(e: FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    const isEdit = Boolean(modelForm.id);
    const res = await fetch("/api/admin/model", {
      method: isEdit ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(modelForm),
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) {
      setError(data.message || "Unable to save model option.");
      return;
    }
    setModelFormOpen(false);
    setNotice(isEdit ? "Model option updated." : "Model option created.");
    await loadAdminData();
  }

  async function deleteModelOption(option: ModelOption) {
    if (!window.confirm(`Delete ${option.provider}/${option.model}?`)) return;
    setError("");
    const res = await fetch("/api/admin/model", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: option.id }),
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) {
      setError(data.message || "Unable to delete model option.");
      return;
    }
    setNotice("Model option deleted.");
    await loadAdminData();
  }

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return users;
    return users.filter((user) =>
      [user.phone, user.isAdmin ? "admin" : "user", String(user.chatCount), formatDate(user.createdAt)]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [users, userSearch]);

  const userPageCount = Math.max(1, Math.ceil(filteredUsers.length / PAGE_SIZE));
  const visibleUsers = filteredUsers.slice((userPage - 1) * PAGE_SIZE, userPage * PAGE_SIZE);

  const modelRows = useMemo(() => {
    const rows = modelOptionsList;
    const q = modelSearch.trim().toLowerCase();
    return q ? rows.filter((row) => `${row.provider} ${row.model} ${formatDate(row.createdAt)}`.toLowerCase().includes(q)) : rows;
  }, [modelOptionsList, modelSearch]);

  const modelPageCount = Math.max(1, Math.ceil(modelRows.length / PAGE_SIZE));
  const visibleModels = modelRows.slice((modelPage - 1) * PAGE_SIZE, modelPage * PAGE_SIZE);
  const availableModels = modelOptions[settings.provider] || [];

  return (
    <div className="admin-shell">
      <aside className="admin-rail">
        <a href="/" className="admin-logo-link" aria-label="RadiantMedAI chat">
          <RadiantLogo />
        </a>
        <nav className="admin-nav" aria-label="Admin sections">
          <button type="button" className={section === "users" ? "is-active" : ""} onClick={() => setSection("users")}>
            Users
          </button>
          <button type="button" className={section === "models" ? "is-active" : ""} onClick={() => setSection("models")}>
            Models
          </button>
        </nav>
        <div className="admin-rail-spacer" />
        <button type="button" className="admin-rail-action" onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}>
          {theme === "dark" ? "Light" : "Dark"}
        </button>
        <a href="/" className="admin-rail-action">Chat</a>
      </aside>

      <main className="admin-main">
        <header className="admin-topbar">
          <div>
            <div className="admin-eyebrow">RadiantMedAI</div>
            <h1>Admin panel</h1>
          </div>
          <div className="admin-topbar-actions">
            <span className="admin-badge">{authUser?.isAdmin ? authUser.phone : "Admin login required"}</span>
            {authUser ? <button type="button" onClick={signOut}>Sign out</button> : null}
          </div>
        </header>

        <section className="admin-content">
          <AnimatePresence>
            {error ? (
              <motion.div className="admin-error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                {error}
              </motion.div>
            ) : null}
            {notice ? (
              <motion.div className="admin-notice" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                {notice}
              </motion.div>
            ) : null}
          </AnimatePresence>

          {!authUser?.isAdmin ? (
            <motion.form className="admin-card admin-login" onSubmit={onLogin} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
              <h2>Sign in</h2>
              <label>
                Admin phone
                <input value={phone} onChange={(e) => setPhone(e.target.value)} />
              </label>
              <label>
                Password
                <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" />
              </label>
              <button type="submit">Open admin panel</button>
            </motion.form>
          ) : section === "users" ? (
            <motion.section className="admin-card admin-table-card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
              <div className="admin-table-toolbar">
                <div>
                  <h2>Users</h2>
                  <p>{filteredUsers.length} users found</p>
                </div>
                <div className="admin-table-tools">
                  <input value={userSearch} onChange={(e) => { setUserSearch(e.target.value); setUserPage(1); }} placeholder="Search users" />
                  <button type="button" onClick={openCreateUser}>Add user</button>
                </div>
              </div>
              <div className="admin-table-wrap">
                <table className="admin-data-table">
                  <thead>
                    <tr>
                      <th>Phone</th>
                      <th>Role</th>
                      <th>Chats</th>
                      <th>Created</th>
                      <th>Updated</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleUsers.map((user) => (
                      <tr key={user.id}>
                        <td>{user.phone}</td>
                        <td>{user.isAdmin ? "Admin" : "User"}</td>
                        <td>{user.chatCount}</td>
                        <td>{formatDate(user.createdAt)}</td>
                        <td>{formatDate(user.updatedAt)}</td>
                        <td>
                          <div className="table-actions">
                            <button type="button" onClick={() => openEditUser(user)}>Edit</button>
                            <button type="button" onClick={() => void toggleUserAdmin(user)}>
                              {user.isAdmin ? "Remove admin" : "Make admin"}
                            </button>
                            <button type="button" className="danger" onClick={() => void deleteUser(user)}>Delete</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={userPage} pageCount={userPageCount} onPage={setUserPage} />
            </motion.section>
          ) : (
            <motion.section className="admin-grid" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
              <form className="admin-card" onSubmit={saveModel}>
                <h2>Active model</h2>
                <label>
                  Provider
                  <select
                    value={settings.provider}
                    onChange={(e) => {
                      const provider = e.target.value as ModelSettings["provider"];
                      const firstModel = modelOptions[provider]?.[0] || "";
                      setSettings({ provider, model: firstModel || settings.model });
                    }}
                  >
                    <option value="ollama">Ollama local</option>
                    <option value="openai">OpenAI</option>
                    <option value="deepseek">DeepSeek</option>
                  </select>
                </label>
                <label>
                  Model
                  <input
                    value={settings.model}
                    onChange={(e) => setSettings((prev) => ({ ...prev, model: e.target.value }))}
                    list="model-options"
                  />
                  <datalist id="model-options">
                    {availableModels.map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                </label>
                <p className="admin-note">
                  Ollama stays local and is the default. OpenAI requires OPENAI_API_KEY; DeepSeek requires DEEPSEEK_API_KEY.
                </p>
                <button type="submit" disabled={saving}>{saving ? "Saving..." : "Save active model"}</button>
              </form>

              <section className="admin-card admin-table-card">
                <div className="admin-table-toolbar">
                  <div>
                    <h2>Model options</h2>
                    <p>{modelRows.length} configured options</p>
                  </div>
                  <div className="admin-table-tools">
                    <input value={modelSearch} onChange={(e) => { setModelSearch(e.target.value); setModelPage(1); }} placeholder="Search models" />
                    <button type="button" onClick={openCreateModel}>Add model</button>
                  </div>
                </div>
                <div className="admin-table-wrap">
                  <table className="admin-data-table">
                    <thead>
                      <tr>
                        <th>Provider</th>
                        <th>Model</th>
                        <th>Status</th>
                        <th>Created</th>
                        <th>Updated</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleModels.map((row) => {
                        const active = row.provider === settings.provider && row.model === settings.model;
                        return (
                          <tr key={`${row.provider}-${row.model}`}>
                            <td>{row.provider}</td>
                            <td>{row.model}</td>
                            <td>{active ? "Active" : "Available"}</td>
                            <td>{formatDate(row.createdAt)}</td>
                            <td>{formatDate(row.updatedAt)}</td>
                            <td>
                              <div className="table-actions">
                                <button type="button" onClick={() => setSettings({ provider: row.provider, model: row.model })}>
                                  Select
                                </button>
                                <button type="button" onClick={() => openEditModel(row)}>
                                  Edit
                                </button>
                                <button type="button" className="danger" onClick={() => void deleteModelOption(row)}>
                                  Delete
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <Pagination page={modelPage} pageCount={modelPageCount} onPage={setModelPage} />
              </section>
            </motion.section>
          )}
        </section>
      </main>

      <AnimatePresence>
        {userFormOpen ? (
          <motion.div className="auth-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.form
              className="auth-card admin-user-modal"
              onSubmit={saveUser}
              initial={{ opacity: 0, y: 18, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
            >
              <button type="button" className="auth-close" aria-label="Close user form" onClick={() => setUserFormOpen(false)}>
                x
              </button>
              <div className="auth-brand">
                <RadiantLogo />
                <div>
                  <h2>{userForm.id ? "Edit user" : "Add user"}</h2>
                  <p>{userForm.id ? "Leave password blank to keep the current password." : "Create a PostgreSQL-backed login."}</p>
                </div>
              </div>
              <label>
                Phone number
                <input value={userForm.phone} onChange={(e) => setUserForm((prev) => ({ ...prev, phone: e.target.value }))} />
              </label>
              <label>
                Password
                <input
                  value={userForm.password}
                  onChange={(e) => setUserForm((prev) => ({ ...prev, password: e.target.value }))}
                  type="password"
                  placeholder={userForm.id ? "Optional password reset" : "Minimum 6 characters"}
                />
              </label>
              <label className="admin-check">
                <input
                  checked={userForm.isAdmin}
                  onChange={(e) => setUserForm((prev) => ({ ...prev, isAdmin: e.target.checked }))}
                  type="checkbox"
                />
                Admin access
              </label>
              <button type="submit" className="auth-submit">{userForm.id ? "Save user" : "Create user"}</button>
            </motion.form>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {modelFormOpen ? (
          <motion.div className="auth-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.form
              className="auth-card admin-user-modal"
              onSubmit={saveModelOption}
              initial={{ opacity: 0, y: 18, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
            >
              <button type="button" className="auth-close" aria-label="Close model form" onClick={() => setModelFormOpen(false)}>
                x
              </button>
              <div className="auth-brand">
                <RadiantLogo />
                <div>
                  <h2>{modelForm.id ? "Edit model option" : "Add model option"}</h2>
                  <p>Add provider/model names that admins can select as the active chat model.</p>
                </div>
              </div>
              <label>
                Provider
                <select
                  value={modelForm.provider}
                  onChange={(e) => setModelForm((prev) => ({ ...prev, provider: e.target.value as ModelSettings["provider"] }))}
                >
                  <option value="ollama">Ollama local</option>
                  <option value="openai">OpenAI</option>
                  <option value="deepseek">DeepSeek</option>
                </select>
              </label>
              <label>
                Model
                <input value={modelForm.model} onChange={(e) => setModelForm((prev) => ({ ...prev, model: e.target.value }))} />
              </label>
              <button type="submit" className="auth-submit">{modelForm.id ? "Save model" : "Create model"}</button>
            </motion.form>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Pagination({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="admin-pagination">
      <button type="button" disabled={page <= 1} onClick={() => onPage(Math.max(1, page - 1))}>
        Previous
      </button>
      <span>Page {page} of {pageCount}</span>
      <button type="button" disabled={page >= pageCount} onClick={() => onPage(Math.min(pageCount, page + 1))}>
        Next
      </button>
    </div>
  );
}
