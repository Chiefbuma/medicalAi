import { NextResponse } from "next/server";
import { authenticateUser } from "@/lib/chat-store";
import { createSessionToken, sessionCookieMaxAge, sessionCookieValue } from "@/lib/auth-session";

export const runtime = "nodejs";

type AuthBody = {
  phone?: string;
  password?: string;
};

function normalizePhone(phone: string) {
  return phone.replace(/[^\d+]/g, "").trim();
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as AuthBody;
    const phone = normalizePhone(body.phone || "");
    const password = body.password || "";

    if (phone.length < 7 || password.length < 6) {
      return NextResponse.json({ message: "Phone number or password is incorrect." }, { status: 401 });
    }

    const user = await authenticateUser(phone, password);
    if (!user) {
      return NextResponse.json({ message: "Phone number or password is incorrect." }, { status: 401 });
    }

    const response = NextResponse.json({ user });
    response.cookies.set(sessionCookieValue(), createSessionToken(user.id), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: sessionCookieMaxAge(),
      path: "/",
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to sign in.";
    return NextResponse.json({ message }, { status: 500 });
  }
}
