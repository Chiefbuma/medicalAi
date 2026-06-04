import { Pool } from "pg";
import { randomBytes, timingSafeEqual, pbkdf2 as pbkdf2Callback } from "crypto";
import { promisify } from "util";

export type StoredChatMessage = {
  id: number;
  sessionId: string;
  role: "user" | "assistant";
  message: string;
  createdAt: string;
};

export type StoredChatSession = {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredChatMessage[];
};

export type AppUser = {
  id: number;
  phone: string;
  isAdmin: boolean;
  createdAt: string;
  updatedAt?: string;
};

export type AdminUser = AppUser & {
  chatCount: number;
};

export const MAX_CHAT_SESSIONS_PER_USER = 5;

export type ModelProvider = "ollama" | "openai" | "deepseek";

export type ModelSettings = {
  provider: ModelProvider;
  model: string;
  updatedAt?: string;
};

export type ModelOption = {
  id: number;
  provider: ModelProvider;
  model: string;
  createdAt: string;
  updatedAt: string;
};

export type PathwayDetails = {
  title: string;
  summary: string;
  managementText: string;
  sourceSection: string;
  investigations: string[];
};

export type PathwayNode = PathwayDetails & {
  conditionKey: string;
  conditionName: string;
  nodeKey: string;
  severity: "routine" | "urgent" | "emergency" | "critical";
  disposition: string;
  criteria: Record<string, unknown>;
  requiredFacts: string[];
};

export type KeywordGuidelineHit = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
};

let pool: Pool | null = null;
let initialized = false;
const pbkdf2 = promisify(pbkdf2Callback);

function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.CLINICAL_POSTGRES_HOST || "clinical-postgres",
      port: Number(process.env.CLINICAL_POSTGRES_PORT || 5432),
      user: process.env.CLINICAL_POSTGRES_USER || "clinical_user",
      password: process.env.CLINICAL_POSTGRES_PASSWORD || "clinical_password",
      database: process.env.CLINICAL_POSTGRES_DB || "clinical_pathways",
      max: 5,
    });
  }

  return pool;
}

async function ensureChatTables() {
  if (initialized) return;

  await getPool().query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id BIGSERIAL PRIMARY KEY,
      phone TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE app_users
    ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS app_model_options (
      id BIGSERIAL PRIMARY KEY,
      provider TEXT NOT NULL CHECK (provider IN ('ollama', 'openai', 'deepseek')),
      model TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(provider, model)
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      user_id BIGINT REFERENCES app_users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE chat_sessions
    ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES app_users(id) ON DELETE CASCADE;

    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id
    ON chat_messages(session_id);

    CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id
    ON chat_sessions(user_id);
  `);

  await ensureDefaultAdmin();
  await ensureDefaultModelSettings();
  await ensureDefaultModelOptions();

  initialized = true;
}

function normalizePhone(phone: string) {
  return phone.replace(/[^\d+]/g, "").trim();
}

async function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const hash = await pbkdf2(password, salt, 120000, 32, "sha256");
  return {
    salt,
    hash: hash.toString("hex"),
  };
}

async function verifyPassword(password: string, salt: string, expectedHash: string) {
  const { hash } = await hashPassword(password, salt);
  const actual = Buffer.from(hash, "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function ensureDefaultAdmin() {
  const phone = normalizePhone(process.env.ADMIN_PHONE || "+254700000000");
  const password = process.env.ADMIN_PASSWORD || "Admin@12345";
  const existing = await getPool().query("SELECT id FROM app_users WHERE phone = $1 LIMIT 1", [phone]);

  if (existing.rows.length) {
    await getPool().query("UPDATE app_users SET is_admin = true, updated_at = now() WHERE phone = $1", [phone]);
    return;
  }

  const { hash, salt } = await hashPassword(password);
  await getPool().query(
    `
      INSERT INTO app_users (phone, password_hash, password_salt, is_admin, updated_at)
      VALUES ($1, $2, $3, true, now())
    `,
    [phone, hash, salt],
  );
}

async function ensureDefaultModelSettings() {
  await getPool().query(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('model_settings', $1::jsonb, now())
      ON CONFLICT (key) DO NOTHING
    `,
    [JSON.stringify({ provider: "ollama", model: process.env.OLLAMA_MODEL || "phi4-mini:3.8b" })],
  );
}

async function ensureDefaultModelOptions() {
  const defaults: Array<[ModelProvider, string]> = [
    ["ollama", process.env.OLLAMA_MODEL || "phi4-mini:3.8b"],
    ["ollama", "phi4-mini:3.8b"],
    ["ollama", "llama3.1"],
    ["ollama", "llama3.2"],
    ["ollama", "mistral"],
    ["ollama", "qwen2.5"],
    ["ollama", "gemma2"],
    ["openai", "gpt-4.1-mini"],
    ["openai", "gpt-4.1"],
    ["openai", "gpt-4o-mini"],
    ["deepseek", "deepseek-chat"],
    ["deepseek", "deepseek-reasoner"],
  ];

  for (const [provider, model] of defaults) {
    await getPool().query(
      `
        INSERT INTO app_model_options (provider, model, updated_at)
        VALUES ($1, $2, now())
        ON CONFLICT (provider, model) DO NOTHING
      `,
      [provider, model],
    );
  }
}

export async function createUser(phone: string, password: string): Promise<AppUser> {
  await ensureChatTables();
  const normalizedPhone = normalizePhone(phone);
  const { hash, salt } = await hashPassword(password);

  const result = await getPool().query<{
    id: number;
    phone: string;
    is_admin: boolean;
    created_at: Date;
  }>(
    `
      INSERT INTO app_users (phone, password_hash, password_salt, updated_at)
      VALUES ($1, $2, $3, now())
      RETURNING id, phone, is_admin, created_at
    `,
    [normalizedPhone, hash, salt],
  );

  const row = result.rows[0];
  return {
    id: Number(row.id),
    phone: row.phone,
    isAdmin: row.is_admin,
    createdAt: row.created_at.toISOString(),
  };
}

export async function createUserForAdmin(phone: string, password: string, isAdmin = false): Promise<AppUser> {
  await ensureChatTables();
  const normalizedPhone = normalizePhone(phone);
  const { hash, salt } = await hashPassword(password);

  const result = await getPool().query<{
    id: number;
    phone: string;
    is_admin: boolean;
    created_at: Date;
    updated_at: Date;
  }>(
    `
      INSERT INTO app_users (phone, password_hash, password_salt, is_admin, updated_at)
      VALUES ($1, $2, $3, $4, now())
      RETURNING id, phone, is_admin, created_at, updated_at
    `,
    [normalizedPhone, hash, salt, isAdmin],
  );

  const row = result.rows[0];
  return {
    id: Number(row.id),
    phone: row.phone,
    isAdmin: row.is_admin,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function authenticateUser(phone: string, password: string): Promise<AppUser | null> {
  await ensureChatTables();
  const normalizedPhone = normalizePhone(phone);

  const result = await getPool().query<{
    id: number;
    phone: string;
    password_hash: string;
    password_salt: string;
    is_admin: boolean;
    created_at: Date;
  }>(
    `
      SELECT id, phone, password_hash, password_salt, is_admin, created_at
      FROM app_users
      WHERE phone = $1
      LIMIT 1
    `,
    [normalizedPhone],
  );

  const row = result.rows[0];
  if (!row) return null;
  const valid = await verifyPassword(password, row.password_salt, row.password_hash);
  if (!valid) return null;

  return {
    id: Number(row.id),
    phone: row.phone,
    isAdmin: row.is_admin,
    createdAt: row.created_at.toISOString(),
  };
}

export async function getUserById(userId: number): Promise<AppUser | null> {
  await ensureChatTables();
  const result = await getPool().query<{
    id: number;
    phone: string;
    is_admin: boolean;
    created_at: Date;
  }>(
    `
      SELECT id, phone, is_admin, created_at
      FROM app_users
      WHERE id = $1
      LIMIT 1
    `,
    [userId],
  );

  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    phone: row.phone,
    isAdmin: row.is_admin,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listUsersForAdmin(): Promise<AdminUser[]> {
  await ensureChatTables();
  const result = await getPool().query<{
    id: number;
    phone: string;
    is_admin: boolean;
    created_at: Date;
    updated_at: Date;
    chat_count: string;
  }>(`
    SELECT
      u.id,
      u.phone,
      u.is_admin,
      u.created_at,
      u.updated_at,
      COUNT(s.id)::text AS chat_count
    FROM app_users u
    LEFT JOIN chat_sessions s ON s.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `);

  return result.rows.map((row) => ({
    id: Number(row.id),
    phone: row.phone,
    isAdmin: row.is_admin,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    chatCount: Number(row.chat_count),
  }));
}

export async function setUserAdmin(userId: number, isAdmin: boolean) {
  await ensureChatTables();
  await getPool().query("UPDATE app_users SET is_admin = $2, updated_at = now() WHERE id = $1", [userId, isAdmin]);
}

export async function updateUserForAdmin(
  userId: number,
  updates: { phone?: string; password?: string; isAdmin?: boolean },
): Promise<AppUser | null> {
  await ensureChatTables();
  const normalizedPhone = updates.phone ? normalizePhone(updates.phone) : undefined;
  const passwordParts = updates.password ? await hashPassword(updates.password) : null;

  const result = await getPool().query<{
    id: number;
    phone: string;
    is_admin: boolean;
    created_at: Date;
    updated_at: Date;
  }>(
    `
      UPDATE app_users
      SET
        phone = COALESCE($2, phone),
        password_hash = COALESCE($3, password_hash),
        password_salt = COALESCE($4, password_salt),
        is_admin = COALESCE($5, is_admin),
        updated_at = now()
      WHERE id = $1
      RETURNING id, phone, is_admin, created_at, updated_at
    `,
    [
      userId,
      normalizedPhone || null,
      passwordParts?.hash || null,
      passwordParts?.salt || null,
      typeof updates.isAdmin === "boolean" ? updates.isAdmin : null,
    ],
  );

  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    phone: row.phone,
    isAdmin: row.is_admin,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function deleteUserById(userId: number) {
  await ensureChatTables();
  await getPool().query("DELETE FROM app_users WHERE id = $1", [userId]);
}

export async function getModelSettings(): Promise<ModelSettings> {
  await ensureChatTables();
  const result = await getPool().query<{ value: ModelSettings; updated_at: Date }>(
    `
      SELECT value, updated_at
      FROM app_settings
      WHERE key = 'model_settings'
      LIMIT 1
    `,
  );

  const row = result.rows[0];
  const value = row?.value || { provider: "ollama", model: process.env.OLLAMA_MODEL || "phi4-mini:3.8b" };
  return {
    provider: value.provider || "ollama",
    model: value.model || process.env.OLLAMA_MODEL || "phi4-mini:3.8b",
    updatedAt: row?.updated_at?.toISOString(),
  };
}

export async function updateModelSettings(provider: ModelProvider, model: string): Promise<ModelSettings> {
  await ensureChatTables();
  const settings = { provider, model };
  const result = await getPool().query<{ value: ModelSettings; updated_at: Date }>(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('model_settings', $1::jsonb, now())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      RETURNING value, updated_at
    `,
    [JSON.stringify(settings)],
  );

  return {
    ...result.rows[0].value,
    updatedAt: result.rows[0].updated_at.toISOString(),
  };
}

export async function listModelOptions(): Promise<ModelOption[]> {
  await ensureChatTables();
  const result = await getPool().query<{
    id: number;
    provider: ModelProvider;
    model: string;
    created_at: Date;
    updated_at: Date;
  }>(`
    SELECT id, provider, model, created_at, updated_at
    FROM app_model_options
    ORDER BY provider ASC, model ASC
  `);

  return result.rows.map((row) => ({
    id: Number(row.id),
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

export async function createModelOption(provider: ModelProvider, model: string): Promise<ModelOption> {
  await ensureChatTables();
  const result = await getPool().query<{
    id: number;
    provider: ModelProvider;
    model: string;
    created_at: Date;
    updated_at: Date;
  }>(
    `
      INSERT INTO app_model_options (provider, model, updated_at)
      VALUES ($1, $2, now())
      RETURNING id, provider, model, created_at, updated_at
    `,
    [provider, model],
  );

  const row = result.rows[0];
  return {
    id: Number(row.id),
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function updateModelOption(id: number, provider: ModelProvider, model: string): Promise<ModelOption | null> {
  await ensureChatTables();
  const result = await getPool().query<{
    id: number;
    provider: ModelProvider;
    model: string;
    created_at: Date;
    updated_at: Date;
  }>(
    `
      UPDATE app_model_options
      SET provider = $2, model = $3, updated_at = now()
      WHERE id = $1
      RETURNING id, provider, model, created_at, updated_at
    `,
    [id, provider, model],
  );

  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function deleteModelOption(id: number) {
  await ensureChatTables();
  await getPool().query("DELETE FROM app_model_options WHERE id = $1", [id]);
}

export async function saveChatMessage(
  sessionId: string,
  role: "user" | "assistant",
  message: string,
  userId?: number,
) {
  await ensureChatTables();

  if (userId) {
    await assertUserCanUseSession(sessionId, userId);
  }

  await getPool().query(
    `
      INSERT INTO chat_sessions (session_id, user_id, updated_at)
      VALUES ($1, $2, now())
      ON CONFLICT (session_id)
      DO UPDATE SET
        updated_at = now(),
        user_id = COALESCE(chat_sessions.user_id, EXCLUDED.user_id)
    `,
    [sessionId, userId || null],
  );

  await getPool().query(
    `
      INSERT INTO chat_messages (session_id, role, message)
      SELECT session_id, $2, $3
      FROM chat_sessions
      WHERE session_id = $1
        AND ($4::bigint IS NULL OR user_id = $4)
    `,
    [sessionId, role, message, userId || null],
  );
}

export async function countChatSessions(userId: number): Promise<number> {
  await ensureChatTables();
  const result = await getPool().query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM chat_sessions WHERE user_id = $1",
    [userId],
  );
  return Number(result.rows[0]?.count || 0);
}

export async function assertUserCanUseSession(sessionId: string, userId: number) {
  await ensureChatTables();
  const existing = await getPool().query("SELECT id FROM chat_sessions WHERE session_id = $1 AND user_id = $2 LIMIT 1", [
    sessionId,
    userId,
  ]);
  if (existing.rows.length) return;

  const count = await countChatSessions(userId);
  if (count >= MAX_CHAT_SESSIONS_PER_USER) {
    const error = new Error(`Chat history limit reached. Delete all chat history before starting another session.`);
    error.name = "ChatSessionLimitError";
    throw error;
  }
}

export async function listChatSessions(userId?: number): Promise<StoredChatSession[]> {
  await ensureChatTables();

  const result = await getPool().query<{
    session_id: string;
    session_created_at: Date;
    session_updated_at: Date;
    message_id: number | null;
    role: "user" | "assistant" | null;
    message: string | null;
    message_created_at: Date | null;
  }>(
    `
    SELECT
      s.session_id,
      s.created_at AS session_created_at,
      s.updated_at AS session_updated_at,
      m.id AS message_id,
      m.role,
      m.message,
      m.created_at AS message_created_at
    FROM chat_sessions s
    LEFT JOIN chat_messages m ON m.session_id = s.session_id
    WHERE ($1::bigint IS NULL OR s.user_id = $1)
    ORDER BY s.updated_at DESC, m.created_at ASC, m.id ASC
  `,
    [userId || null],
  );

  const sessions = new Map<string, StoredChatSession>();

  for (const row of result.rows) {
    const session =
      sessions.get(row.session_id) ||
      {
        sessionId: row.session_id,
        createdAt: row.session_created_at.toISOString(),
        updatedAt: row.session_updated_at.toISOString(),
        messages: [],
      };

    if (row.message_id && row.role && row.message && row.message_created_at) {
      session.messages.push({
        id: row.message_id,
        sessionId: row.session_id,
        role: row.role,
        message: row.message,
        createdAt: row.message_created_at.toISOString(),
      });
    }

    sessions.set(row.session_id, session);
  }

  return [...sessions.values()];
}

export async function getRecentChatMessages(sessionId: string, limit = 8, userId?: number): Promise<StoredChatMessage[]> {
  await ensureChatTables();

  const result = await getPool().query<{
    id: number;
    session_id: string;
    role: "user" | "assistant";
    message: string;
    created_at: Date;
  }>(
    `
      SELECT
        chat_messages.id,
        chat_messages.session_id,
        chat_messages.role,
        chat_messages.message,
        chat_messages.created_at
      FROM chat_messages
      JOIN chat_sessions s ON s.session_id = chat_messages.session_id
      WHERE chat_messages.session_id = $1
        AND ($3::bigint IS NULL OR s.user_id = $3)
      ORDER BY chat_messages.created_at DESC, chat_messages.id DESC
      LIMIT $2
    `,
    [sessionId, limit, userId || null],
  );

  return result.rows
    .reverse()
    .map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      message: row.message,
      createdAt: row.created_at.toISOString(),
    }));
}

export async function getPathwayDetailsByTitle(title: string): Promise<PathwayDetails | null> {
  try {
    const result = await getPool().query<{
      title: string;
      summary: string;
      management_text: string;
      source_section: string;
      investigation_name: string | null;
    }>(
      `
        SELECT
          pn.title,
          pn.summary,
          pn.management_text,
          pn.source_section,
          i.name AS investigation_name
        FROM clinical.pathway_nodes pn
        LEFT JOIN clinical.pathway_investigations pi ON pi.pathway_node_id = pn.id
        LEFT JOIN clinical.investigations i ON i.id = pi.investigation_id
        WHERE lower(pn.title) = lower($1)
        ORDER BY i.name ASC
      `,
      [title],
    );

    if (!result.rows.length) return null;

    const first = result.rows[0];
    return {
      title: first.title,
      summary: first.summary,
      managementText: first.management_text,
      sourceSection: first.source_section,
      investigations: result.rows
        .map((row) => row.investigation_name)
        .filter((name): name is string => Boolean(name)),
    };
  } catch (error) {
    console.error("Unable to load pathway details", error);
    return null;
  }
}

export async function listPathwayNodes(): Promise<PathwayNode[]> {
  try {
    const result = await getPool().query<{
      condition_key: string;
      condition_name: string;
      node_key: string;
      title: string;
      severity: "routine" | "urgent" | "emergency" | "critical";
      disposition: string | null;
      criteria: Record<string, unknown>;
      required_facts: string[];
      summary: string;
      management_text: string;
      source_section: string;
      investigation_name: string | null;
    }>(`
      SELECT
        c.condition_key,
        c.title AS condition_name,
        pn.node_key,
        pn.title,
        pn.severity,
        pn.disposition,
        pn.criteria,
        pn.required_facts,
        pn.summary,
        pn.management_text,
        pn.source_section,
        i.name AS investigation_name
      FROM clinical.pathway_nodes pn
      JOIN clinical.conditions c ON c.id = pn.condition_id
      LEFT JOIN clinical.pathway_investigations pi ON pi.pathway_node_id = pn.id
      LEFT JOIN clinical.investigations i ON i.id = pi.investigation_id
      ORDER BY pn.display_order ASC, i.name ASC
    `);

    const nodes = new Map<string, PathwayNode>();
    for (const row of result.rows) {
      const existing =
        nodes.get(row.node_key) ||
        {
          conditionKey: row.condition_key,
          conditionName: row.condition_name,
          nodeKey: row.node_key,
          title: row.title,
          severity: row.severity,
          disposition: row.disposition || "not specified",
          criteria: row.criteria || {},
          requiredFacts: row.required_facts || [],
          summary: row.summary,
          managementText: row.management_text,
          sourceSection: row.source_section,
          investigations: [],
        };

      if (row.investigation_name && !existing.investigations.includes(row.investigation_name)) {
        existing.investigations.push(row.investigation_name);
      }

      nodes.set(row.node_key, existing);
    }

    return [...nodes.values()];
  } catch (error) {
    console.error("Unable to list pathway nodes", error);
    return [];
  }
}

export async function keywordSearchGuideline(query: string, limit = 8): Promise<KeywordGuidelineHit[]> {
  await ensureChatTables();
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];

  try {
    const result = await getPool().query<{
      id: number;
      condition_key: string;
      condition_name: string;
      node_key: string;
      title: string;
      summary: string;
      management_text: string;
      source_section: string;
      rank: number;
    }>(
      `
        WITH pathway_text AS (
          SELECT
            pn.id,
            c.condition_key,
            c.title AS condition_name,
            pn.node_key,
            pn.title,
            pn.summary,
            pn.management_text,
            pn.source_section,
            to_tsvector(
              'english',
              concat_ws(' ', c.title, pn.title, pn.summary, pn.management_text, pn.criteria::text, array_to_string(pn.required_facts, ' '))
            ) AS document_vector
          FROM clinical.pathway_nodes pn
          JOIN clinical.conditions c ON c.id = pn.condition_id
        ),
        query AS (
          SELECT websearch_to_tsquery('english', $1) AS q
        )
        SELECT
          pathway_text.*,
          ts_rank_cd(pathway_text.document_vector, query.q) AS rank
        FROM pathway_text, query
        WHERE query.q @@ pathway_text.document_vector
        ORDER BY rank DESC
        LIMIT $2
      `,
      [normalizedQuery, limit],
    );

    return result.rows.map((row) => ({
      id: `pathway-${row.id}`,
      content: [
        row.condition_name,
        row.title,
        row.summary,
        row.management_text,
      ].filter(Boolean).join("\n\n"),
      metadata: {
        id: `pathway-${row.id}`,
        conditionKey: row.condition_key,
        nodeKey: row.node_key,
        sectionNumber: row.source_section,
        chunkIndex: row.id,
        keywordScore: Number(row.rank),
        retrievalMode: "keyword",
      },
    }));
  } catch (error) {
    console.error("Keyword guideline search failed", error);
    return [];
  }
}

export async function deleteChatSession(sessionId: string, userId?: number) {
  await ensureChatTables();
  await getPool().query("DELETE FROM chat_sessions WHERE session_id = $1 AND ($2::bigint IS NULL OR user_id = $2)", [
    sessionId,
    userId || null,
  ]);
}

export async function deleteAllChatSessions(userId: number) {
  await ensureChatTables();
  await getPool().query("DELETE FROM chat_sessions WHERE user_id = $1", [userId]);
}
