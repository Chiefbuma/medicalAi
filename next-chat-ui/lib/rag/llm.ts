import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import type { AIMessageChunk } from "@langchain/core/messages";
import { RAG_CONFIG } from "./config";
import { getModelSettings } from "@/lib/chat-store";

export async function getChatModel() {
  const settings = await getModelSettings();

  if (settings.provider === "openai") {
    if (!RAG_CONFIG.openAiApiKey) {
      throw new Error("OpenAI is selected, but OPENAI_API_KEY is not configured.");
    }

    return new ChatOpenAI({
      apiKey: RAG_CONFIG.openAiApiKey,
      model: settings.model,
      temperature: 0.1,
      streaming: true,
    });
  }

  if (settings.provider === "deepseek") {
    if (!RAG_CONFIG.deepSeekApiKey) {
      throw new Error("DeepSeek is selected, but DEEPSEEK_API_KEY is not configured.");
    }

    return new ChatOpenAI({
      apiKey: RAG_CONFIG.deepSeekApiKey,
      model: settings.model,
      configuration: {
        baseURL: RAG_CONFIG.deepSeekBaseUrl,
      },
      temperature: 0.1,
      streaming: true,
    });
  }

  return new ChatOllama({
    baseUrl: RAG_CONFIG.ollamaBaseUrl,
    model: settings.model || RAG_CONFIG.ollamaChatModel,
    temperature: 0.1,
    streaming: true,
  });
}

export function chunkToText(chunk: AIMessageChunk) {
  const content = chunk.content;
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if ("text" in part && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}
