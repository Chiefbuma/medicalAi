const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "on",
  "in",
  "at",
  "by",
  "for",
  "to",
  "with",
  "about",
  "from",
  "patient",
  "patients",
]);

function normalizePlural(word: string) {
  if (word.length <= 3) return word;
  if (/men$/.test(word)) return word.replace(/men$/, "man");
  if (/([^aeiou])ies$/.test(word)) return word.replace(/([^aeiou])ies$/, "$1y");
  if (/ies$/.test(word)) return word.replace(/ies$/, "y");
  if (/([^aeiou])ves$/.test(word)) return word.replace(/([^aeiou])ves$/, "$1f");
  if (/(xes|zes|ches|shes)$/.test(word)) return word.replace(/es$/, "");
  if (/s$/.test(word) && !/(ss|us)$/.test(word)) return word.slice(0, -1);
  return word;
}

function normalizeWordOrder(text: string) {
  return text
    .replace(/\b(injur(?:y|ies)|trauma|burns?|wounds?|fractures?|pain|bleeding)\s+(?:on|to|in|of)\s+(?:the\s+)?([a-z]+)\b/g, "$2 $1")
    .replace(/\b([a-z]+)\s+(?:injuries|injury|trauma)\b/g, "$1 injury");
}

function normalizeVerbForms(word: string) {
  if (word === "bleeding") return "bleed";
  if (word === "vomiting") return "vomit";
  if (word === "breathing") return "breath";
  if (word === "managing") return "manage";
  if (word === "treating") return "treat";
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  return word;
}

function normalizeActionPhrases(text: string) {
  return text
    .replace(/\bhow\s+(?:do you|to|can i|does one|do one|don one)\s+(?:manage|treat|handle)\b/g, "management")
    .replace(/\bwhat\s+(?:is\s+)?(?:the\s+)?(?:management|treatment)\s+(?:of|for)\b/g, "management")
    .replace(/\b(?:management|treatment)\s+(?:of|for)\b/g, "management");
}

function deduplicateWords(words: string[]) {
  const normalized: string[] = [];
  for (const word of words) {
    if (normalized[normalized.length - 1] === word) continue;
    normalized.push(word);
  }
  return normalized;
}

export function normalizeClinicalQueryText(input: string) {
  const ordered = normalizeWordOrder(input.toLowerCase());
  const actionNormalized = normalizeActionPhrases(ordered);
  const words = actionNormalized
    .replace(/[^\p{L}\p{N}%/+<>=.-]+/gu, " ")
    .split(/\s+/)
    .map((word) => normalizeVerbForms(normalizePlural(word.trim())))
    .filter((word) => word && !STOP_WORDS.has(word));

  return deduplicateWords(words).join(" ").replace(/\s+/g, " ").trim();
}

export function hasClearConditionPhrase(input: string) {
  const normalized = normalizeClinicalQueryText(input);
  return /\b(?:head injury|burn|pv bleed|vaginal bleed|per vaginal|asthma|pneumonia|hyperkalaemia|hyperkalemia|hyponatraemia|hyponatremia|hypernatraemia|hypernatremia|diabetic ketoacidosis|dka|abdominal injury|chest injury|chest trauma|epigastric pain)\b/.test(
    normalized,
  );
}
