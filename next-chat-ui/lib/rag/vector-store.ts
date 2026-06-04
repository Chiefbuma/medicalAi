import { QdrantVectorStore } from "@langchain/qdrant";
import { OllamaEmbeddings } from "@langchain/ollama";
import type { Document } from "@langchain/core/documents";
import { RAG_CONFIG } from "./config";

let embeddingsInstance: OllamaEmbeddings | null = null;
let vectorStoreInstance: QdrantVectorStore | null = null;

export function getEmbeddings() {
  if (!embeddingsInstance) {
    embeddingsInstance = new OllamaEmbeddings({
      baseUrl: RAG_CONFIG.ollamaBaseUrl,
      model: RAG_CONFIG.ollamaEmbeddingModel,
    });
  }

  return embeddingsInstance;
}

export async function getVectorStore() {
  if (!vectorStoreInstance) {
    const embeddings = getEmbeddings();
    const sampleVector = await embeddings.embedQuery("clinical guideline readiness check");

    vectorStoreInstance = new QdrantVectorStore(embeddings, {
      url: RAG_CONFIG.qdrantUrl,
      apiKey: RAG_CONFIG.qdrantApiKey,
      collectionName: RAG_CONFIG.qdrantCollection,
      collectionConfig: {
        vectors: {
          size: sampleVector.length,
          distance: "Cosine",
        },
      },
    });

    await vectorStoreInstance.ensureCollection();
  }

  return vectorStoreInstance;
}

export async function addDocuments(documents: Document[]) {
  if (!documents.length) return;

  const vectorStore = await getVectorStore();
  const ids = documents.map((document) => String(document.metadata.id));
  await vectorStore.addDocuments(documents, { ids });
}

export async function searchRelevantChunks(query: string, k = RAG_CONFIG.retrievalK) {
  const vectorStore = await getVectorStore();
  const results = await vectorStore.similaritySearchWithScore(query, k);

  return results.map(([document, score]) => {
    document.metadata = {
      ...document.metadata,
      score,
    };
    return document;
  });
}
