import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/auth-session";
import {
  createModelOption,
  deleteModelOption,
  getModelSettings,
  getUserById,
  listModelOptions,
  updateModelOption,
  updateModelSettings,
  type ModelProvider,
} from "@/lib/chat-store";

export const runtime = "nodejs";

const providers = new Set<ModelProvider>(["ollama", "openai", "deepseek"]);

async function requireAdmin(req: Request) {
  const userId = getSessionUserId(req);
  if (!userId) return null;
  const user = await getUserById(userId);
  return user?.isAdmin ? user : null;
}

export async function GET(req: Request) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ message: "Admin access required." }, { status: 403 });

  const settings = await getModelSettings();
  const modelOptions = await listModelOptions();
  const options = modelOptions.reduce<Record<string, string[]>>((acc, option) => {
    acc[option.provider] ||= [];
    acc[option.provider].push(option.model);
    return acc;
  }, {});

  return NextResponse.json({
    settings,
    modelOptions,
    options,
  });
}

export async function POST(req: Request) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ message: "Admin access required." }, { status: 403 });

  const body = (await req.json()) as { provider?: ModelProvider; model?: string };
  const provider = body.provider;
  const model = body.model?.trim();

  if (!provider || !providers.has(provider) || !model) {
    return NextResponse.json({ message: "Valid provider and model are required." }, { status: 400 });
  }

  try {
    const option = await createModelOption(provider, model);
    return NextResponse.json({ option }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error && /duplicate|unique/i.test(error.message)
      ? "That model option already exists."
      : "Unable to create model option.";
    return NextResponse.json({ message }, { status: 400 });
  }
}

export async function PUT(req: Request) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ message: "Admin access required." }, { status: 403 });

  const body = (await req.json()) as { provider?: ModelProvider; model?: string };
  const provider = body.provider;
  const model = body.model?.trim();

  if (!provider || !providers.has(provider) || !model) {
    return NextResponse.json({ message: "Valid provider and model are required." }, { status: 400 });
  }

  const settings = await updateModelSettings(provider, model);
  return NextResponse.json({ settings });
}

export async function PATCH(req: Request) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ message: "Admin access required." }, { status: 403 });

  const body = (await req.json()) as { id?: number; provider?: ModelProvider; model?: string };
  const provider = body.provider;
  const model = body.model?.trim();

  if (!body.id || !provider || !providers.has(provider) || !model) {
    return NextResponse.json({ message: "Valid id, provider, and model are required." }, { status: 400 });
  }

  try {
    const option = await updateModelOption(body.id, provider, model);
    if (!option) return NextResponse.json({ message: "Model option not found." }, { status: 404 });
    return NextResponse.json({ option });
  } catch (error) {
    const message = error instanceof Error && /duplicate|unique/i.test(error.message)
      ? "That model option already exists."
      : "Unable to update model option.";
    return NextResponse.json({ message }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ message: "Admin access required." }, { status: 403 });

  const body = (await req.json()) as { id?: number };
  if (!body.id) return NextResponse.json({ message: "id is required." }, { status: 400 });

  await deleteModelOption(body.id);
  return NextResponse.json({ success: true });
}
