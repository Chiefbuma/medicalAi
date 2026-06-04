import { NextResponse } from "next/server";
import { createUser } from "@/lib/chat-store";
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

    if (phone.length < 7) {
      return NextResponse.json({ message: "Enter a valid phone number." }, { status: 400 });
    }

    if (password.length < 6) {
      return NextResponse.json({ message: "Password must be at least 6 characters." }, { status: 400 });
    }

    const user = await createUser(phone, password);
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
    const message = error instanceof Error && /duplicate key|unique/i.test(error.message)
      ? "This phone number is already registered."
      : error instanceof Error
        ? error.message
        : "Unable to register.";
    const status = /already registered/i.test(message) ? 409 : 500;
    return NextResponse.json({ message }, { status });
  }
}
