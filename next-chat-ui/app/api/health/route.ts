import { NextResponse } from "next/server";
import { getPublicRagConfig } from "@/lib/rag/config";

export const runtime = "nodejs";

async function check(url: string) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    return { ok: res.ok, status: res.status };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "unreachable",
    };
  }
}

export async function GET() {
  const config = getPublicRagConfig();
  const [ollama, qdrant] = await Promise.all([
    check(`${config.ollamaBaseUrl}/api/tags`),
    check(`${config.qdrantUrl}/collections`),
  ]);

  const ok = ollama.ok && qdrant.ok;
  return NextResponse.json({ ok, config, services: { ollama, qdrant } }, { status: ok ? 200 : 503 });
}
