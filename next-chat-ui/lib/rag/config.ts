export const RAG_CONFIG = {
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://ollama:11434",
  ollamaChatModel: process.env.OLLAMA_MODEL || "phi4-mini:3.8b",
  ollamaEmbeddingModel: process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text",
  openAiApiKey: process.env.OPENAI_API_KEY || "",
  deepSeekApiKey: process.env.DEEPSEEK_API_KEY || "",
  deepSeekBaseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
  qdrantUrl: process.env.QDRANT_URL || "http://qdrant:6333",
  qdrantApiKey: process.env.QDRANT_API_KEY || undefined,
  qdrantCollection: process.env.QDRANT_COLLECTION || "clinical_guidelines",
  sharedDataRoot: process.env.SHARED_DATA_ROOT || "/data/shared",
  retrievalK: Number(process.env.RAG_RETRIEVAL_K || 4),
  maxContextChars: Number(process.env.RAG_MAX_CONTEXT_CHARS || 6_000),
};

export function getPublicRagConfig() {
  return {
    ollamaBaseUrl: RAG_CONFIG.ollamaBaseUrl,
    ollamaChatModel: RAG_CONFIG.ollamaChatModel,
    ollamaEmbeddingModel: RAG_CONFIG.ollamaEmbeddingModel,
    qdrantUrl: RAG_CONFIG.qdrantUrl,
    qdrantCollection: RAG_CONFIG.qdrantCollection,
    retrievalK: RAG_CONFIG.retrievalK,
  };
}
