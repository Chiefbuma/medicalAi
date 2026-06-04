export type ClinicalFactStatus = "present" | "absent" | "unknown";
export type NegationCertainty = "high" | "medium" | null;

export type ClinicalFactState = {
  status: ClinicalFactStatus;
  negationCertainty: NegationCertainty;
};

function patternSource(pattern: RegExp) {
  return pattern.source.replace(/^\^|\$$/g, "");
}

function textWindow(concept: RegExp, before: string, after: string, words = 8) {
  const c = patternSource(concept);
  return new RegExp(`${before}(?:\\W+\\w+){0,${words}}\\W+(?:${c})|(?:${c})(?:\\W+\\w+){0,${words}}\\W+${after}`);
}

export function negatesConcept(text: string, concept: RegExp, explicitNegative?: RegExp): ClinicalFactState {
  const normalized = text.toLowerCase();
  const c = patternSource(concept);
  const highBefore =
    "\\b(?:no|not|without|denies?|denied|absence of|absent|free of|negative for|no evidence of|ruled out|nil|none)\\b";
  const highAfter =
    "\\b(?:absent|negative|resolved|stopped|settled|subsided|not present|not observed|has stopped|has resolved|ruled out)\\b";
  const mediumBefore = "\\b(?:likely no|likely not|probably no|probably not|unlikely|less likely|doubtful for)\\b";
  const mediumAfter = "\\b(?:less likely|unlikely|doubtful)\\b";
  const doubleNegation = new RegExp(
    `\\b(?:not|no longer)\\s+(?:absent|negative|ruled out|resolved|stopped)\\b(?:\\W+\\w+){0,8}\\W+(?:${c})|(?:${c})(?:\\W+\\w+){0,8}\\W+\\b(?:not|no longer)\\s+(?:absent|negative|ruled out|resolved|stopped)\\b`,
  );

  if (doubleNegation.test(normalized)) {
    return { status: "present", negationCertainty: null };
  }

  if (textWindow(concept, mediumBefore, mediumAfter).test(normalized)) {
    return { status: "absent", negationCertainty: "medium" };
  }

  if (explicitNegative?.test(normalized) || textWindow(concept, highBefore, highAfter).test(normalized)) {
    return { status: "absent", negationCertainty: "high" };
  }

  if (concept.test(normalized)) {
    return { status: "present", negationCertainty: null };
  }

  return { status: "unknown", negationCertainty: null };
}

export function booleanConcept(text: string, positive: RegExp, explicitNegative?: RegExp) {
  const state = negatesConcept(text, positive, explicitNegative);
  if (state.status === "present") return true;
  if (state.status === "absent" && state.negationCertainty === "high") return false;
  return undefined;
}

export function conceptMemoryState(
  text: string,
  concept: RegExp,
  explicitNegative: RegExp | undefined,
  positiveLabel: string,
  negativeLabel: string,
) {
  const state = negatesConcept(text, concept, explicitNegative);
  if (state.status === "present") return positiveLabel;
  if (state.status === "absent" && state.negationCertainty === "high") return negativeLabel;
  if (state.status === "absent" && state.negationCertainty === "medium") {
    return `uncertain: ${negativeLabel}`;
  }
  return undefined;
}
