import { createHmac, timingSafeEqual } from "crypto";

const COOKIE_NAME = "radiantmedai_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 14;

function secret() {
  return process.env.AUTH_SESSION_SECRET || process.env.CLINICAL_POSTGRES_PASSWORD || "radiantmedai_dev_secret";
}

function base64url(input: string | Buffer) {
  return Buffer.from(input).toString("base64url");
}

function signPayload(payload: string) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function createSessionToken(userId: number) {
  const payload = base64url(JSON.stringify({ userId, exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS }));
  return `${payload}.${signPayload(payload)}`;
}

export function sessionCookieValue() {
  return COOKIE_NAME;
}

export function sessionCookieMaxAge() {
  return MAX_AGE_SECONDS;
}

export function verifySessionToken(token: string | undefined) {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = signPayload(payload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      userId?: number;
      exp?: number;
    };
    if (!parsed.userId || !parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return parsed.userId;
  } catch {
    return null;
  }
}

export function getSessionUserId(req: Request) {
  const cookie = req.headers.get("cookie") || "";
  const token = cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);

  return verifySessionToken(token);
}
