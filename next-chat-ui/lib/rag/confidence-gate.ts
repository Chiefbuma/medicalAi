import type { Document } from "@langchain/core/documents";

export type ConfidenceDecision = {
  shouldAnswer: boolean;
  confidence: number;
  reason?: string;
};

export function guidelineConfidenceGate(documents: Document[]): ConfidenceDecision {
  if (!documents.length) {
    return {
      shouldAnswer: false,
      confidence: 0,
      reason: "No relevant information was found in the internal clinical guideline.",
    };
  }

  const top = documents[0].metadata as Record<string, unknown>;
  const hybridScore = typeof top.hybridScore === "number" ? top.hybridScore : 0;
  const vectorScore = typeof top.score === "number" ? top.score : 0;
  const keywordScore = typeof top.keywordScore === "number" ? top.keywordScore : 0;
  const confidence = Math.max(hybridScore * 20, vectorScore, keywordScore);

  if (confidence < 0.35) {
    return {
      shouldAnswer: false,
      confidence,
      reason:
        "The retrieved internal clinical guideline context is not specific enough for this question.",
    };
  }

  return {
    shouldAnswer: true,
    confidence,
  };
}

export function formatConfidenceRefusal(decision: ConfidenceDecision) {
  return `${decision.reason || "The internal clinical guideline context is not specific enough for this question."}

Please confirm the condition or pathway you mean, or provide the main complaint and key clinical facts.

Source:
Internal clinical guideline, relevant section not confidently retrieved, confidence ${decision.confidence.toFixed(3)}`;
}
