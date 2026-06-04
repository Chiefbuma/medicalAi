import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/auth-session";
import {
  createUserForAdmin,
  deleteUserById,
  getUserById,
  listUsersForAdmin,
  updateUserForAdmin,
} from "@/lib/chat-store";

export const runtime = "nodejs";

async function requireAdmin(req: Request) {
  const userId = getSessionUserId(req);
  if (!userId) return null;
  const user = await getUserById(userId);
  return user?.isAdmin ? user : null;
}

export async function GET(req: Request) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ message: "Admin access required." }, { status: 403 });

  const users = await listUsersForAdmin();
  return NextResponse.json({ users });
}

export async function POST(req: Request) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ message: "Admin access required." }, { status: 403 });

  const body = (await req.json()) as { phone?: string; password?: string; isAdmin?: boolean };
  const phone = body.phone?.trim();
  const password = body.password?.trim();

  if (!phone || !password || password.length < 6) {
    return NextResponse.json({ message: "Phone and a password of at least 6 characters are required." }, { status: 400 });
  }

  try {
    const user = await createUserForAdmin(phone, password, Boolean(body.isAdmin));
    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error && /duplicate|unique/i.test(error.message)
      ? "A user with that phone number already exists."
      : "Unable to create user.";
    return NextResponse.json({ message }, { status: 400 });
  }
}

export async function PATCH(req: Request) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ message: "Admin access required." }, { status: 403 });

  const body = (await req.json()) as { userId?: number; phone?: string; password?: string; isAdmin?: boolean };
  if (!body.userId) {
    return NextResponse.json({ message: "userId is required." }, { status: 400 });
  }

  if (body.userId === admin.id && body.isAdmin === false) {
    return NextResponse.json({ message: "You cannot remove your own admin access." }, { status: 400 });
  }

  if (body.password !== undefined && body.password.trim().length > 0 && body.password.trim().length < 6) {
    return NextResponse.json({ message: "Password must be at least 6 characters." }, { status: 400 });
  }

  try {
    const user = await updateUserForAdmin(body.userId, {
      phone: body.phone?.trim() || undefined,
      password: body.password?.trim() || undefined,
      isAdmin: typeof body.isAdmin === "boolean" ? body.isAdmin : undefined,
    });
    if (!user) return NextResponse.json({ message: "User not found." }, { status: 404 });
    return NextResponse.json({ user });
  } catch (error) {
    const message = error instanceof Error && /duplicate|unique/i.test(error.message)
      ? "A user with that phone number already exists."
      : "Unable to update user.";
    return NextResponse.json({ message }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ message: "Admin access required." }, { status: 403 });

  const body = (await req.json()) as { userId?: number };
  if (!body.userId) return NextResponse.json({ message: "userId is required." }, { status: 400 });
  if (body.userId === admin.id) {
    return NextResponse.json({ message: "You cannot delete your own admin account." }, { status: 400 });
  }

  await deleteUserById(body.userId);
  return NextResponse.json({ success: true });
}
