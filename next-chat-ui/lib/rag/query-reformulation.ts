export function reformulateClinicalQuery(input: string, contextualInput: string, isFollowUp: boolean) {
  if (!isFollowUp || !contextualInput.includes("Same-session case memory")) {
    return contextualInput;
  }

  const memoryMatch = contextualInput.match(/Updated case memory including current message:\n([\s\S]*?)\nCurrent doctor message:/i);
  const memory = memoryMatch?.[1]?.trim();
  if (!memory || /No structured case facts/.test(memory)) return contextualInput;

  return [
    "Standalone clinical query rewritten from same-session memory.",
    "Use these current patient facts as the active case:",
    memory,
    `Current doctor question/update: ${input}`,
  ].join("\n");
}
