import { Document } from "@langchain/core/documents";
import { keywordSearchGuideline } from "@/lib/chat-store";
import { RAG_CONFIG } from "@/lib/rag/config";
import { searchRelevantChunks } from "@/lib/rag/vector-store";

function documentKey(doc: Document) {
  const metadata = doc.metadata as Record<string, unknown>;
  return String(metadata.id || `${metadata.source || "doc"}:${metadata.chunkIndex || doc.pageContent.slice(0, 32)}`);
}

function rrfScore(rank: number) {
  return 1 / (60 + rank + 1);
}

export async function searchHybridGuideline(query: string, k = RAG_CONFIG.retrievalK) {
  const [vectorDocs, keywordHits] = await Promise.all([
    searchRelevantChunks(query, k * 2),
    keywordSearchGuideline(query, k * 2),
  ]);

  const docsByKey = new Map<string, Document>();
  const scores = new Map<string, number>();

  vectorDocs.forEach((doc, rank) => {
    const key = documentKey(doc);
    docsByKey.set(key, doc);
    scores.set(key, (scores.get(key) || 0) + rrfScore(rank));
  });

  keywordHits.forEach((hit, rank) => {
    const doc = new Document({
      pageContent: hit.content,
      metadata: hit.metadata,
    });
    const key = documentKey(doc);
    docsByKey.set(key, doc);
    scores.set(key, (scores.get(key) || 0) + rrfScore(rank));
  });

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([key, hybridScore]) => {
      const doc = docsByKey.get(key)!;
      doc.metadata = {
        ...doc.metadata,
        hybridScore,
      };
      return doc;
    });
}
