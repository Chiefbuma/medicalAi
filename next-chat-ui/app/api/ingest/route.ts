import { NextResponse } from "next/server";
import { addDocuments } from "@/lib/rag/vector-store";
import { processClinicalGuidelines } from "@/lib/rag/document-processor";

export const runtime = "nodejs";
export const maxDuration = 900;

type IngestBody = {
  paths?: string[];
};

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as IngestBody;
    const { pdfPaths, documents } = await processClinicalGuidelines(body.paths);

    await addDocuments(documents);

    return NextResponse.json({
      success: true,
      filesIndexed: pdfPaths.length,
      chunksIndexed: documents.length,
      files: pdfPaths,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to ingest clinical guidelines";
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
