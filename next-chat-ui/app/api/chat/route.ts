import { NextResponse } from "next/server";
import { getChatModel, chunkToText } from "@/lib/rag/llm";
import {
  buildAsthmaSeverityGuardedAnswer,
  buildBloodPressureGuardedAnswer,
  buildMedicalPrompt,
  buildRetrievalQuery,
  formatContext,
} from "@/lib/rag/prompts";
import { searchHybridGuideline } from "@/lib/rag/hybrid-search";
import { RAG_CONFIG } from "@/lib/rag/config";
import { buildPathwayGuardedAnswer } from "@/lib/rag/pathway-guards";
import { assertUserCanUseSession, getRecentChatMessages, saveChatMessage, type StoredChatMessage } from "@/lib/chat-store";
import { conceptMemoryState } from "@/lib/rag/clinical-negation";
import { getSessionUserId } from "@/lib/auth-session";
import { routeChatIntent } from "@/lib/rag/intent-router";
import { reformulateClinicalQuery } from "@/lib/rag/query-reformulation";
import { formatConfidenceRefusal, guidelineConfidenceGate } from "@/lib/rag/confidence-gate";

export const runtime = "nodejs";
export const maxDuration = 900;

type ChatBody = {
  chatInput?: string;
  sessionId?: string;
  userId?: number;
};

function streamError(message: string, status = 500) {
  return NextResponse.json({ message }, { status });
}

async function saveChatMessageBestEffort(
  sessionId: string | undefined,
  userId: number | undefined,
  role: "user" | "assistant",
  message: string,
) {
  if (!sessionId || !message.trim()) return;

  try {
    await saveChatMessage(sessionId, role, message, userId);
  } catch (error) {
    console.error("Unable to save chat message", error);
  }
}

async function getConversationContext(sessionId: string | undefined, userId: number | undefined, chatInput: string) {
  if (!sessionId) return chatInput;

  try {
    const recentMessages = await getRecentChatMessages(sessionId, 40, userId);
    const previousDoctorMessages = recentMessages
      .filter((message) => message.role === "user")
      .map((message) => message.message.trim())
      .filter(Boolean);

    if (!previousDoctorMessages.length) return chatInput;

    const previousCaseMemory = buildSameSessionCaseMemory(recentMessages);
    const caseMemory = buildSameSessionCaseMemory(recentMessages, chatInput);

    return [
      "Same-session case memory. Treat the current doctor message as the newest update for this same patient unless it explicitly says this is a new patient or new case.",
      "Previous case memory before current message:",
      previousCaseMemory,
      "Updated case memory including current message:",
      caseMemory,
      `Current doctor message: ${chatInput}`,
    ].join("\n");
  } catch (error) {
    console.error("Unable to load chat context", error);
    return chatInput;
  }
}

function latestMatchingValue<T>(
  messages: string[],
  extractor: (message: string) => T | undefined,
) {
  for (const message of messages.slice().reverse()) {
    const value = extractor(message.toLowerCase());
    if (value !== undefined) return value;
  }

  return undefined;
}

function conceptState(message: string, concept: RegExp, negative: RegExp | undefined, positiveLabel: string, negativeLabel: string) {
  return conceptMemoryState(message, concept, negative, positiveLabel, negativeLabel);
}

function detectConditionMemory(messages: string[]) {
  const text = messages.join("\n").toLowerCase();
  const conditions: string[] = [];

  if (/pregnan.*bleed|bleed.*pregnan|vaginal bleeding|pv bleeding|per vaginal|abortion|miscarriage/.test(text)) {
    conditions.push("per vaginal bleeding in pregnancy");
  } else if (/vaginal bleeding|pv bleeding|per vaginal|uterine bleeding/.test(text)) {
    conditions.push("per vaginal bleeding");
  }

  if (/asthma|asthmatic|wheeze|wheez|pulsus|paradoxus|silent chest/.test(text)) {
    conditions.push("asthma attack");
  }

  if (/diabetic ketoacidosis|\bdka\b|ketone|kussmaul|polyuria|blood sugar|glucose/.test(text)) {
    conditions.push("diabetic ketoacidosis");
  }

  if (/burn|tbsa|scald|full thickness|partial thickness/.test(text)) {
    conditions.push("burns");
  }

  if (/hyperkalaemia|hyperkalemia|potassium/.test(text)) {
    conditions.push("hyperkalaemia");
  }

  if (/pneumonia|fast breathing|difficult breathing|difficulty breathing|chest indrawing/.test(text)) {
    conditions.push("pneumonia / difficult breathing");
  }

  return conditions;
}

function gestationMemory(message: string) {
  if (!/pregnan|gestation|antenatal|weeks pregnant/.test(message)) return undefined;

  const before = message.match(/(?:before|less than|under|below|<)\s*(\d{1,2})\s*(?:weeks|wks)/);
  if (before) return `gestation less than ${before[1]} weeks`;

  const after = message.match(/(?:more than|over|above|after|>)\s*(\d{1,2})\s*(?:weeks|wks)/);
  if (after) return `gestation more than ${after[1]} weeks`;

  const plain = message.match(/(?:gestation(?:al)?(?: age| period)?(?: is| of|:)?\s*)?(\d{1,2})\s*(?:weeks|wks)/);
  if (plain) return `gestation ${plain[1]} weeks`;

  return undefined;
}

function childAgeMemory(message: string) {
  const lower = message.toLowerCase();
  if (!/child|boy|girl|infant|baby|neonate|newborn|paediatric|pediatric|age|old/.test(lower)) return undefined;

  const daysWithComparator = lower.match(/(?:child|boy|girl|infant|baby|neonate|newborn|age|aged|old|is)?\s*(less than|under|below|<|more than|over|above|>)\s*(\d{1,3})\s*(?:days|day)\b/);
  if (daysWithComparator) {
    const comparator = daysWithComparator[1];
    const value = daysWithComparator[2];
    return /less than|under|below|</.test(comparator)
      ? `child age less than ${value} days`
      : `child age more than ${value} days`;
  }

  const weeks = lower.match(/(?:age|aged|old|is|less than|under|below|<)?\s*(\d{1,3})\s*(?:weeks|week|wks|wk)\b/);
  if (weeks) return lower.match(/less than|under|below|</)
    ? `child age less than ${weeks[1]} weeks`
    : `child age ${weeks[1]} weeks`;

  const months = lower.match(/(?:age|aged|old|is|less than|under|below|<)?\s*(\d{1,2})\s*(?:months|month|mos|mo)\b/);
  if (months) return lower.match(/less than|under|below|</)
    ? `child age less than ${months[1]} months`
    : `child age ${months[1]} months`;

  const days = lower.match(/(?:age|aged|old|is|less than|under|below|<)?\s*(\d{1,3})\s*(?:days|day)\b/);
  if (days) return lower.match(/less than|under|below|</)
    ? `child age less than ${days[1]} days`
    : `child age ${days[1]} days`;

  return undefined;
}

function patientAgeMemory(message: string) {
  const lower = message.toLowerCase();
  if (!/patient|man|woman|adult|male|female|age|aged|years|year|yrs|yr/.test(lower)) return undefined;
  if (/child|boy|girl|infant|baby|neonate|newborn|weeks|months|days/.test(lower)) return undefined;

  const years = lower.match(/(?:age|aged|is)?\s*(\d{1,3})\s*(?:years|year|yrs|yr)\b/);
  if (years) return `age ${years[1]} years`;

  const plainAge = lower.match(/(?:age|aged)\s*(?:is|=|:)?\s*(\d{1,3})\b/);
  if (plainAge) return `age ${plainAge[1]} years`;

  return undefined;
}

function burnDetailsMemory(message: string) {
  const lower = message.toLowerCase();
  if (!/burn|tbsa|partial thickness|full thickness|superficial/.test(lower)) return undefined;

  const details: string[] = [];
  if (/full[-\s]?thickness|third degree/.test(lower)) details.push("full-thickness burn");
  else if (/partial[-\s]?thickness|second degree/.test(lower)) details.push("partial-thickness burn");
  else if (/superficial|first degree/.test(lower)) details.push("superficial burn");

  const tbsa = lower.match(/(\d{1,3})\s*%/);
  if (tbsa) details.push(`${tbsa[1]}% TBSA stated`);

  const location = lower.match(/\b(?:on|involving)\s+([a-z,\s]+?)(?:\.|$)/);
  if (location?.[1]) details.push(`location: ${location[1].trim()}`);

  if (/face|hands?|feet|genitalia|perineum|major joints?/.test(lower)) details.push("special-area involvement mentioned");
  if (/back/.test(lower) && !/face|hands?|feet|genitalia|perineum|major joints?/.test(lower)) details.push("back involvement mentioned");

  return details.length ? details.join("; ") : undefined;
}

function shockMemory(message: string) {
  return conceptState(
    message,
    /shock|faint|collapse|confus|dizz|cold|clammy|weak thready pulse|poor perfusion/,
    /haemodynamically stable|hemodynamically stable|stable patient|patient is stable|normal perfusion|warm extremities|normal capillary refill/,
    "signs of shock",
    "haemodynamically stable",
  );
}

function activeBleedingMemory(message: string) {
  return conceptState(
    message,
    /bleeding|active bleeding|ongoing bleeding|fresh bleeding|heavy bleeding|continued bleeding/,
    /dry pad|no fresh bleeding/,
    "active bleeding",
    "bleeding stopped",
  );
}

function pregnancyMemory(message: string) {
  return conceptState(
    message,
    /pregnan|gestation|weeks pregnant|antenatal/,
    /not pregnant|non-pregnant|non pregnant|pregnancy test negative|negative pregnancy test/,
    "pregnant",
    "not pregnant",
  );
}

function respiratoryMemory(message: string) {
  return conceptState(
    message,
    /fast breathing|difficult breathing|difficulty breathing|chest indrawing|wheez\w*|shortness of breath|respiratory distress/,
    /normal breathing|breathing normal/,
    "respiratory symptoms present",
    "no respiratory distress features stated",
  );
}

function pneumoniaSeverityMemory(message: string) {
  const lower = message.toLowerCase();
  if (/very severe pneumonia|unable to drink|unable to feed|cannot drink|cannot feed|letharg|unconscious|convulsion|seizure|central cyanosis|stridor/.test(lower)) {
    return "very severe pneumonia";
  }
  if (/sever\w*\s+pneumonia|chest indrawing/.test(lower)) {
    return "severe pneumonia";
  }
  if (/non-?severe pneumonia|fast breathing|tachypnoea|tachypnea/.test(lower)) {
    return "non-severe pneumonia";
  }
  if (/no pneumonia/.test(lower)) {
    return "no pneumonia";
  }

  return undefined;
}

function neurologicalMemory(message: string) {
  return conceptState(
    message,
    /confus|drows|letharg|unconscious|seizure|convulsion|reduced consciousness|slow mental/,
    /normal mental state|alert|conscious/,
    "neurological danger feature present",
    "no neurological danger feature stated",
  );
}

function vomitingMemory(message: string) {
  return conceptState(message, /vomit\w*|emesis/, undefined, "vomiting present", "no vomiting");
}

function feverMemory(message: string) {
  return conceptState(message, /fever|hotness|pyrexia/, /afebrile/, "fever present", "no fever");
}

function targetOrganMemory(message: string) {
  return conceptState(
    message,
    /severe headache|blurred vision|epigastric pain|oliguria|liver tenderness|seizure|convulsion|target organ/,
    undefined,
    "target-organ symptoms present",
    "no target-organ symptoms stated",
  );
}

function buildSameSessionCaseMemory(recentMessages: StoredChatMessage[], chatInput?: string) {
  const doctorMessages = recentMessages
    .filter((message) => message.role === "user")
    .map((message) => message.message.trim())
    .filter(Boolean);
  const messages = chatInput ? [...doctorMessages, chatInput] : doctorMessages;
  const lines: string[] = [];
  const conditions = detectConditionMemory(messages);
  const pregnancy = latestMatchingValue(messages, pregnancyMemory);
  const childAge = latestMatchingValue(messages, childAgeMemory);
  const patientAge = latestMatchingValue(messages, patientAgeMemory);
  const gestation = latestMatchingValue(messages, gestationMemory);
  const haemodynamic = latestMatchingValue(messages, shockMemory);
  const bleeding = latestMatchingValue(messages, activeBleedingMemory);
  const respiratory = latestMatchingValue(messages, respiratoryMemory);
  const pneumoniaSeverity = latestMatchingValue(messages, pneumoniaSeverityMemory);
  const neurological = latestMatchingValue(messages, neurologicalMemory);
  const vomiting = latestMatchingValue(messages, vomitingMemory);
  const fever = latestMatchingValue(messages, feverMemory);
  const targetOrgan = latestMatchingValue(messages, targetOrganMemory);
  const burnDetails = latestMatchingValue(messages, burnDetailsMemory);
  const abortionConcern = messages.some((message) => /abortion|miscarriage/.test(message.toLowerCase()));

  if (conditions.length) lines.push(`Condition under discussion: ${conditions.join(", ")}.`);
  if (pregnancy) lines.push(`Pregnancy status: ${pregnancy}.`);
  if (childAge) lines.push(`Age: ${childAge}.`);
  else if (patientAge) lines.push(`Age: ${patientAge}.`);
  if (gestation) lines.push(`Gestation: ${gestation}.`);
  if (haemodynamic) lines.push(`Haemodynamic status: ${haemodynamic}.`);
  if (bleeding) lines.push(`Bleeding status: ${bleeding}.`);
  if (respiratory) lines.push(`Respiratory status: ${respiratory}.`);
  if (pneumoniaSeverity) lines.push(`Pneumonia classification: ${pneumoniaSeverity}.`);
  if (neurological) lines.push(`Neurological status: ${neurological}.`);
  if (vomiting) lines.push(`Vomiting status: ${vomiting}.`);
  if (fever) lines.push(`Fever status: ${fever}.`);
  if (targetOrgan) lines.push(`Target-organ symptoms: ${targetOrgan}.`);
  if (burnDetails) lines.push(`Burn details: ${burnDetails}.`);
  if (abortionConcern) lines.push("Clinical concern mentioned: abortion or miscarriage.");

  if (!lines.length) return "No structured case facts have been established yet.";
  return lines.join("\n");
}

function cleanAssistantOutput(text: string) {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (/^(dr|doctor|ma|medassistant)\s*:?\s*$/i.test(trimmed)) return false;
      if (/^(since the user|the user asked|the user described|i will provide|i will|based on the context provided)/i.test(trimmed)) {
        return false;
      }
      return true;
    });

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function shouldAskContextCheck(chatInput: string, contextualInput: string) {
  const text = chatInput.toLowerCase();
  if (/new patient|new case|different patient|another patient|separate case|different presentation/.test(text)) {
    return true;
  }

  const memory = previousCaseMemoryFromContext(contextualInput).toLowerCase();
  const previousConditions = new Set(
    (memory.match(/condition under discussion:\s*([^\n.]+)/)?.[1] || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const currentConditions = detectConditionMemory([chatInput]).map((item) => item.toLowerCase());

  if (!previousConditions.size || !currentConditions.length) return false;
  return currentConditions.every((condition) => !previousConditions.has(condition));
}

function addSameCaseConfirmation(answer: string, contextualInput: string, chatInput: string) {
  if (!contextualInput.includes("Same-session case memory")) return answer;
  if (!shouldAskContextCheck(chatInput, contextualInput)) return answer;
  if (/Same case check:/i.test(answer)) return answer;

  const note = `Context check:
- Is this still the same patient/presentation, or is this a new case?`;

  if (answer.includes("\nSource:")) {
    return answer.replace("\nSource:", `\n${note}\n\nSource:`);
  }

  return `${answer}\n\n${note}`;
}

function buildContextCheckAnswer(chatInput: string, contextualInput: string) {
  if (!shouldAskContextCheck(chatInput, contextualInput)) return null;
  const previousMemory = previousCaseMemoryFromContext(contextualInput);
  const currentConditions = detectConditionMemory([chatInput]);

  return `This may be a different presentation from the case we were discussing.

Previous case facts I have:
${previousMemory || "No structured case facts have been established yet."}

New message appears to mention:
${currentConditions.length ? currentConditions.map((condition) => `- ${condition}`).join("\n") : "- a possible new patient or presentation"}

Please confirm: is this the same patient with a new symptom, or a new patient/new case?`;
}

function caseMemoryFromContext(contextualInput: string) {
  if (!contextualInput.includes("Same-session case memory")) return "";
  const currentMarker = "\nCurrent doctor message:";
  const body = contextualInput.split(currentMarker)[0] || "";
  return body
    .replace(/^Same-session case memory\.[^\n]*\n?/i, "")
    .replace(/Previous case memory before current message:\n[\s\S]*?Updated case memory including current message:\n/i, "")
    .trim();
}

function previousCaseMemoryFromContext(contextualInput: string) {
  const match = contextualInput.match(/Previous case memory before current message:\n([\s\S]*?)\nUpdated case memory including current message:/i);
  return match?.[1]?.trim() || caseMemoryFromContext(contextualInput);
}

function buildConversationalAnswer(chatInput: string, contextualInput: string) {
  const text = chatInput.toLowerCase().trim();
  const memory = caseMemoryFromContext(contextualInput);
  const hasCase = Boolean(memory && !/No structured case facts/.test(memory));
  const hasClinicalPayload =
    detectConditionMemory([chatInput]).length > 0 ||
    /vomit|bleed|fever|shock|pregnan|gestation|pneumonia|wheez|asthma|burn|potassium|sodium|glucose|ketone|dehydrat|convulsion|seizure|pain|diarrh|cough|breath|oxygen|spo2|pulse|blood pressure|haemoglobin|hemoglobin|malaria|cbc|fbc/.test(
      text,
    );

  if (/^(hi|hello|hey|good morning|good afternoon|good evening)\b/.test(text)) {
    return `Hello. I can help you match the patient presentation to the internal clinical guideline.

Tell me the main complaint, key vitals, and any important positives or negatives.`;
  }

  if (/who are you|what are you/.test(text)) {
    return `I am RadiantMedAI, a clinical guideline assistant for this app. I use the internal clinical guideline and the facts in this chat session to help classify pathways, suggest follow-up checks, and show management from the guideline.`;
  }

  if (/^(thanks|thank you|ok thanks|okay thanks|great thanks)\b/.test(text)) {
    return "You are welcome.";
  }

  if (/^(what do you mean|explain|explain that|clarify|can you clarify)\??$/.test(text)) {
    if (hasCase) {
      return `In simple terms: I am using the latest facts in this same chat as the current patient picture.

Current case facts I have:
${memory}

If one of those facts is wrong or has changed, tell me the corrected value and I will update the pathway.`;
    }

    return "Which part should I clarify: the possible diagnosis, the urgency, the tests, the medication, or the disposition?";
  }

  if (/^(is that true|is this true|true\??|are you sure)\??$/.test(text)) {
    return `I can verify only against the internal clinical guideline and the facts in this chat.

Which exact statement should I check? For example, ask about the diagnosis, the disposition, a medication dose, or a test recommendation.`;
  }

  if (/^(where|which|why|when)\??$/.test(text)) {
    return `Can you be a little more specific?

For this case, do you mean where in the guideline, which diagnosis/pathway, why that pathway was chosen, or when to admit/escalate?`;
  }

  if (/^(same patient|same case|same presentation)\b/.test(text) && !hasClinicalPayload) {
    return hasCase
      ? `Understood. I will continue treating this as the same patient in this chat.

Current case facts I have:
${memory}`
      : "Understood. I will treat this chat as one patient case. Please give me the main presentation and key clinical facts.";
  }

  if (/^(new patient|new case|different patient|another patient|separate case)\b/.test(text)) {
    return "Understood. Please start with the new patient's main presentation, key vitals, and relevant positives or negatives.";
  }

  if (hasCase && /^(yes|no|not sure|unknown|unclear)\.?$/.test(text)) {
    return `I need one more detail to apply that answer correctly.

What does "${chatInput}" refer to in this patient: bleeding, pregnancy status, shock/stability, a symptom, a test result, or treatment response?`;
  }

  return null;
}

function latestAssistantMessage(messages: StoredChatMessage[]) {
  return messages
    .slice()
    .reverse()
    .find((message) => message.role === "assistant")?.message.trim();
}

function latestClinicalAssistantMessage(messages: StoredChatMessage[]) {
  return messages
    .slice()
    .reverse()
    .find((message) => {
      if (message.role !== "assistant") return false;
      const text = message.message.toLowerCase();
      if (/^(management repeated|diagnostic tests repeated|here is the previous clinical answer|for the current case facts|understood\.|yes, the patient|no, the patient|recommended disposition:)/.test(text)) {
        return false;
      }
      if (!text.includes("source:")) return false;
      return /urgency:|what this means:|recommended disposition:|possible diagnosis based on clinical guidelines:|management and medication guidance:/.test(
        text,
      );
    })?.message.trim();
}

function assistantMessageContainingTerm(messages: StoredChatMessage[], term: string) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped, "i");
  return messages
    .slice()
    .reverse()
    .find((message) => message.role === "assistant" && pattern.test(message.message))?.message.trim();
}

function sourceFromResponse(response: string | undefined) {
  const match = response?.match(/\nSource:\n([\s\S]+)$/i);
  return match?.[1]?.trim();
}

function sectionFromResponse(response: string, headingPatterns: RegExp[], stopHeadings: RegExp) {
  const lines = response.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => headingPatterns.some((pattern) => pattern.test(line.trim())));
  if (start === -1) return "";

  const collected: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (stopHeadings.test(line.trim())) break;
    collected.push(line);
  }

  return collected.join("\n").trim();
}

function dispositionFromResponse(response: string | undefined) {
  if (!response) return "";
  const disposition = sectionFromResponse(
    response,
    [/^recommended disposition:?$/i],
    /^(recommended diagnostic tests|management|would you check|possible diagnosis|source|what this means):?/i,
  );
  if (disposition) return disposition.split("\n")[0]?.trim() || disposition.trim();

  const lower = response.toLowerCase();
  if (/recommended disposition:\s*admit|requires admission|requiring admission|admission\./.test(lower)) return "admit";
  if (/recommended disposition:\s*outpatient|outpatient management|does not require admission/.test(lower)) return "outpatient";
  if (/recommended disposition:\s*specialised_unit|specialised unit|intensive care/.test(lower)) return "specialised_unit";
  return "";
}

function humanDisposition(disposition: string) {
  const normalized = disposition.toLowerCase().trim();
  if (normalized === "admit") return "admission";
  if (normalized === "outpatient") return "outpatient care";
  if (normalized === "specialised_unit") return "specialised unit or intensive care";
  if (normalized === "admit_monitor") return "admission with monitoring";
  return disposition.replace(/_/g, " ");
}

function answerDispositionQuestion(
  target: "admission" | "disposition",
  messages: StoredChatMessage[],
  contextualInput: string,
) {
  const clinicalResponse = latestClinicalAssistantMessage(messages);
  const memory = caseMemoryFromContext(contextualInput);
  const source = sourceFromResponse(clinicalResponse);
  const disposition = dispositionFromResponse(clinicalResponse);

  if (!clinicalResponse || !disposition) {
    return memory && !/No structured case facts/.test(memory)
      ? `I need the pathway to be matched before I can answer that safely.

Current case context:
${memory}

Please provide any missing severity details, then I can answer the disposition directly.`
      : "I need the patient presentation first before I can say whether admission is required.";
  }

  const normalized = disposition.toLowerCase();
  const requiresAdmission = /admit|admission|specialised_unit|specialized_unit|intensive|inpatient|monitor/.test(normalized);
  const reason =
    sectionFromResponse(clinicalResponse, [/^what this means:?$/i], /^(recommended disposition|recommended diagnostic tests|management|source):?/i) ||
    "The matched internal clinical guideline pathway determines the disposition.";

  if (target === "admission") {
    return `${requiresAdmission ? "Yes" : "No"}, the patient ${requiresAdmission ? "requires admission" : "does not require admission"} based on the matched internal clinical guideline pathway.

Reason:
${reason}

Recommended disposition:
${humanDisposition(disposition)}
${source ? `\n\nSource:\n${source}` : ""}`;
  }

  return `Recommended disposition:
${humanDisposition(disposition)}

Reason:
${reason}
${source ? `\n\nSource:\n${source}` : ""}`;
}

function repeatPreviousAnswer(
  focus: "management" | "tests" | "source" | "all" | undefined,
  messages: StoredChatMessage[],
) {
  const clinicalResponse = latestClinicalAssistantMessage(messages);
  const lastResponse = clinicalResponse || latestAssistantMessage(messages);
  if (!lastResponse) {
    return "I do not have a previous response to repeat yet. Please ask a clinical question first.";
  }

  if (focus === "source") {
    const source = sourceFromResponse(lastResponse);
    return source
      ? `The source I used was:\n${source}`
      : "I do not see a source line in the previous response.";
  }

  if (focus === "management") {
    const management = sectionFromResponse(
      lastResponse,
      [/^management and medication guidance:?$/i, /^for this .*recommends:?$/i],
      /^(would you check|possible diagnosis|recommended disposition|recommended diagnostic tests|source):?/i,
    );
    if (management) {
      const disposition = sectionFromResponse(lastResponse, [/^recommended disposition:?$/i], /^(management|would you check|possible diagnosis|source):?/i);
      const source = sourceFromResponse(lastResponse);
      return [
        "Management repeated:",
        management,
        disposition ? `\nRecommended disposition:\n${disposition}` : "",
        source ? `\nSource:\n${source}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
  }

  if (focus === "tests") {
    const tests = sectionFromResponse(
      lastResponse,
      [/^recommended diagnostic tests:?$/i],
      /^(management|would you check|possible diagnosis|recommended disposition|source):?/i,
    );
    const source = sourceFromResponse(lastResponse);
    return tests
      ? [`Diagnostic tests repeated:`, tests, source ? `\nSource:\n${source}` : ""].filter(Boolean).join("\n")
      : "The previous matched pathway did not list specific diagnostic tests in the indexed pathway table.";
  }

  return `Here is the previous clinical answer again:\n\n${lastResponse}`;
}

function answerCompletenessCheck(messages: StoredChatMessage[], contextualInput: string) {
  const clinicalResponse = latestClinicalAssistantMessage(messages);
  if (!clinicalResponse) {
    return "I need a clinical question or matched pathway first before I can check whether anything is missing.";
  }

  const memory = caseMemoryFromContext(contextualInput);
  const management = sectionFromResponse(
    clinicalResponse,
    [/^management and medication guidance:?$/i],
    /^(would you check|possible diagnosis|recommended disposition|recommended diagnostic tests|source):?/i,
  );
  const checks = sectionFromResponse(
    clinicalResponse,
    [/^would you check the following\??$/i],
    /^(possible diagnosis|source):?/i,
  );
  const tests = sectionFromResponse(
    clinicalResponse,
    [/^recommended diagnostic tests:?$/i],
    /^(management|would you check|possible diagnosis|recommended disposition|source):?/i,
  );
  const source = sourceFromResponse(clinicalResponse);

  return [
    memory && !/No structured case facts/.test(memory) ? `For the current case facts I have:\n${memory}` : "",
    "From the indexed internal clinical guideline response, that covers the matched pathway information I have available.",
    management ? `\nManagement already given:\n${management}` : "",
    tests ? `\nDiagnostic tests already listed:\n${tests}` : "\nDiagnostic tests: no specific diagnostic tests were listed in the indexed pathway table for the matched pathway.",
    checks ? `\nRemaining checks to confirm:\n${checks}` : "",
    source ? `\nSource:\n${source}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function answerConfirmation(contextualInput: string) {
  const memory = caseMemoryFromContext(contextualInput);
  if (memory && !/No structured case facts/.test(memory)) {
    return `Understood. I will keep using this same case context:\n${memory}`;
  }

  return "Understood. Please give me the clinical presentation or the next detail you want checked.";
}

function answerClarification(term: string | undefined, messages: StoredChatMessage[], contextualInput: string) {
  const clinicalResponse = latestClinicalAssistantMessage(messages) || latestAssistantMessage(messages);
  const memory = caseMemoryFromContext(contextualInput);
  const cleanTerm = term?.replace(/^["']|["']$/g, "").trim();

  if (cleanTerm) {
    const clinicalResponseWithTerm = assistantMessageContainingTerm(messages, cleanTerm) || clinicalResponse;
    const escaped = cleanTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sentence = clinicalResponseWithTerm
      ?.replace(/\n/g, " ")
      .split(/(?<=[.!?])\s+/)
      .find((item) => new RegExp(escaped, "i").test(item));

    if (sentence) {
      return `In simpler terms, "${cleanTerm}" refers to this part of the previous answer:\n${sentence.trim()}`;
    }
  }

  if (memory && !/No structured case facts/.test(memory)) {
    return `Tell me which part you want clarified: the diagnosis, urgency, tests, medication, disposition, or source.\n\nCurrent case facts I have:\n${memory}`;
  }

  return "Tell me which part you want clarified: the diagnosis, urgency, tests, medication, disposition, or source.";
}

function answerUnclearInput(reason: "control" | "too_short" | "incoherent", contextualInput: string) {
  const memory = caseMemoryFromContext(contextualInput);
  const hasCase = Boolean(memory && !/No structured case facts/.test(memory));

  if (reason === "control") {
    return hasCase
      ? `I will pause here and not treat that as a clinical instruction.

Current case context:
${memory}

If you want to continue, tell me the next clinical detail or ask a specific question such as management, tests, diagnosis, disposition, or source.`
      : "I will pause here. If you want clinical help, please enter the patient's main complaint, age, key vitals, and important positive or negative findings.";
  }

  if (hasCase) {
    return `I am not sure how that relates to the current case, so I will not match a new pathway from it.

Current case context:
${memory}

Can you clarify what you want to do next: add a symptom, ask for management, ask for tests, confirm diagnosis, or start a new patient?`;
  }

  return `I could not identify a clinical question or patient fact from that message.

Please start with a clear presentation, for example: age, main complaint, important symptoms, vital signs, test results, and whether this is a new patient.`;
}

function answerRationaleQuestion(fact: string | undefined, contextualInput: string) {
  const memory = caseMemoryFromContext(contextualInput);
  const memoryLower = memory.toLowerCase();
  const isBurnCase = /burn|tbsa|partial thickness|full thickness|superficial/.test(memoryLower);
  const normalizedFact = (fact || "").toLowerCase();

  if (/age/.test(normalizedFact) && isBurnCase) {
    return `I ask for age because the burn pathway uses age together with burn depth, total body surface area, and special-area involvement to classify severity and disposition.

For burns, age can change risk and escalation decisions, especially in children and older adults. In the current case, you already gave age 35 years, so I should not keep asking for it.

Current case context:
${memory}

What I still need, if not already clear, is the exact burn depth/TBSA combination and whether any special areas are involved.`;
  }

  if (/tbsa|body surface/.test(normalizedFact)) {
    return `I ask for total body surface area because the burn pathway separates mild, moderate, and severe burns by how much skin surface is involved, together with burn depth and special-area involvement.

Current case context:
${memory || "No structured case facts have been established yet."}`;
  }

  if (/burn depth|depth/.test(normalizedFact)) {
    return `I ask for burn depth because superficial, partial-thickness, and full-thickness burns follow different severity branches and management pathways.

Current case context:
${memory || "No structured case facts have been established yet."}`;
  }

  if (/special area/.test(normalizedFact)) {
    return `I ask about special areas because burns on the face, hands, feet, genitalia, perineum, or major joints can require escalation even when the total burned area is smaller.

Current case context:
${memory || "No structured case facts have been established yet."}`;
  }

  if (/pregnancy|gestation/.test(normalizedFact)) {
    return `I ask for pregnancy status or gestational age because the bleeding pathways separate non-pregnant bleeding, early pregnancy bleeding, late pregnancy bleeding, and postpartum bleeding. The management and urgency can differ between those branches.

Current case context:
${memory || "No structured case facts have been established yet."}`;
  }

  if (/shock|blood pressure|oxygen|spo2|potassium|sodium|malaria|cbc|haemoglobin|hemoglobin/.test(normalizedFact)) {
    return `I ask for that detail because it can change the pathway branch, urgency, disposition, tests, or medication guidance in the internal clinical guideline.

Current case context:
${memory || "No structured case facts have been established yet."}`;
  }

  if (memory && !/No structured case facts/.test(memory)) {
    return `I ask follow-up details only when they are needed to choose the correct internal guideline pathway or avoid mixing branches.

Current case context:
${memory}

Tell me which detail you want explained: age, test result, vital sign, symptom, diagnosis, medication, or disposition.`;
  }

  return "I ask follow-up details only when they are needed to choose the correct internal guideline pathway. Tell me which detail you want explained.";
}

function answerExternalGap() {
  return `I do not have external internet search enabled for clinical answers in this app.

I can do one of two things:
- Use the internal clinical guideline for pathway decisions, tests, medications, and disposition.
- Use the selected model's general medical knowledge for a clearly labeled explanation, definition, or rationale.

For current or external evidence, use approved sources such as PubMed, WHO, CDC, NICE, or your institution's updated guideline, then verify with a qualified clinician.`;
}

function buildGeneralKnowledgePrompt(question: string, contextualInput: string, intent: "definition" | "rationale") {
  const memory = caseMemoryFromContext(contextualInput);
  return [
    "You are RadiantMedAI.",
    "Answer using general medical knowledge from the selected language model, not internet browsing.",
    "Do not invent internal guideline citations, section numbers, line numbers, or scores.",
    "Do not provide a full treatment pathway, dose plan, or disposition unless the user explicitly asks for a general explanation; pathway decisions must come from the internal clinical guideline.",
    "Keep the answer concise, practical, and suitable for a doctor.",
    "If the question is unclear, ask one focused clarification question.",
    "",
    memory && !/No structured case facts/.test(memory)
      ? `Current same-session case context:\n${memory}`
      : "Current same-session case context: none established.",
    "",
    `Question type: ${intent}`,
    `Doctor question: ${question}`,
    "",
    "End with this exact source label:",
    "Source: General clinical knowledge from the selected model; not an internal clinical guideline pathway.",
  ].join("\n");
}

function answerNonRetrievalIntent(
  routedIntent: ReturnType<typeof routeChatIntent>,
  messages: StoredChatMessage[],
  contextualInput: string,
) {
  if (routedIntent.type === "direct") return routedIntent.response;
  if (routedIntent.type === "repeat") return repeatPreviousAnswer(routedIntent.focus, messages);
  if (routedIntent.type === "completeness") return answerCompletenessCheck(messages, contextualInput);
  if (routedIntent.type === "confirmation") return answerConfirmation(contextualInput);
  if (routedIntent.type === "clarification") return answerClarification(routedIntent.term, messages, contextualInput);
  if (routedIntent.type === "disposition_question") {
    return answerDispositionQuestion(routedIntent.target, messages, contextualInput);
  }
  if (routedIntent.type === "rationale") {
    const answer = answerRationaleQuestion(routedIntent.fact, contextualInput);
    return answer.includes("Source:")
      ? answer
      : `${answer}\n\nSource: General clinical reasoning from the selected model/rules; not an internal clinical guideline pathway.`;
  }
  if (routedIntent.type === "external_gap") return answerExternalGap();
  if (routedIntent.type === "unclear") return answerUnclearInput(routedIntent.reason, contextualInput);
  return null;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ChatBody;
    const chatInput = body.chatInput?.trim();
    const sessionId = body.sessionId?.trim();
    const userId = getSessionUserId(req) || Number(body.userId || 0) || undefined;

    if (!chatInput) {
      return streamError("chatInput is required", 400);
    }

    if (!userId) {
      return streamError("Authentication is required.", 401);
    }

    if (sessionId) {
      try {
        await assertUserCanUseSession(sessionId, userId);
      } catch (error) {
        if (error instanceof Error && error.name === "ChatSessionLimitError") {
          return streamError(
            "You have reached the limit of 5 saved chat sessions. Please delete all chat history before starting a new consultation.",
            409,
          );
        }
        throw error;
      }
    }

    const previousMessages = sessionId ? await getRecentChatMessages(sessionId, 40, userId) : [];
    const routedIntent = routeChatIntent(chatInput);
    const contextualInput = await getConversationContext(sessionId, userId, chatInput);

    await saveChatMessageBestEffort(sessionId, userId, "user", chatInput);

    const nonRetrievalAnswer = answerNonRetrievalIntent(routedIntent, previousMessages, contextualInput);
    const conversationalAnswer = nonRetrievalAnswer || buildConversationalAnswer(chatInput, contextualInput);
    const contextCheckAnswer = conversationalAnswer ? null : buildContextCheckAnswer(chatInput, contextualInput);
    const clinicalQuery =
      routedIntent.type === "clinical"
        ? reformulateClinicalQuery(chatInput, contextualInput, routedIntent.isFollowUp)
        : contextualInput;

    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(encoder.encode(" "));
          let assistantText = "";
          const write = (text: string) => {
            assistantText += text;
            controller.enqueue(encoder.encode(text));
          };

          if (conversationalAnswer) {
            write(conversationalAnswer);
            await saveChatMessageBestEffort(sessionId, userId, "assistant", assistantText);
            controller.close();
            return;
          }

          if (contextCheckAnswer) {
            write(contextCheckAnswer);
            await saveChatMessageBestEffort(sessionId, userId, "assistant", assistantText);
            controller.close();
            return;
          }

          if (routedIntent.type === "definition") {
            const prompt = buildGeneralKnowledgePrompt(chatInput, contextualInput, "definition");
            const model = await getChatModel();
            const response = await model.stream(prompt);
            let modelText = "";

            for await (const chunk of response) {
              const text = chunkToText(chunk);
              if (text) modelText += text;
            }

            write(cleanAssistantOutput(modelText) || "I need a clearer term to define.");
            await saveChatMessageBestEffort(sessionId, userId, "assistant", assistantText);
            controller.close();
            return;
          }

          const retrievalQuery = buildRetrievalQuery(clinicalQuery);
          const documents = await searchHybridGuideline(retrievalQuery, RAG_CONFIG.retrievalK);

          if (!documents.length) {
            write(
              "No internal clinical guideline context was found. Please ingest the internal clinical guideline first, then ask again.",
            );
            await saveChatMessageBestEffort(sessionId, userId, "assistant", assistantText);
            controller.close();
            return;
          }

          const guardedBloodPressureAnswer = buildBloodPressureGuardedAnswer(contextualInput, documents);
          if (guardedBloodPressureAnswer) {
            write(addSameCaseConfirmation(guardedBloodPressureAnswer, contextualInput, chatInput));
            await saveChatMessageBestEffort(sessionId, userId, "assistant", assistantText);
            controller.close();
            return;
          }

          const guardedAsthmaAnswer = buildAsthmaSeverityGuardedAnswer(contextualInput, documents, chatInput);
          if (guardedAsthmaAnswer) {
            write(addSameCaseConfirmation(guardedAsthmaAnswer, contextualInput, chatInput));
            await saveChatMessageBestEffort(sessionId, userId, "assistant", assistantText);
            controller.close();
            return;
          }

          const guardedPathwayAnswer = await buildPathwayGuardedAnswer(contextualInput, documents, chatInput);
          if (guardedPathwayAnswer) {
            write(addSameCaseConfirmation(guardedPathwayAnswer, contextualInput, chatInput));
            await saveChatMessageBestEffort(sessionId, userId, "assistant", assistantText);
            controller.close();
            return;
          }

          const confidence = guidelineConfidenceGate(documents);
          if (!confidence.shouldAnswer) {
            write(formatConfidenceRefusal(confidence));
            await saveChatMessageBestEffort(sessionId, userId, "assistant", assistantText);
            controller.close();
            return;
          }

          const context = formatContext(documents, RAG_CONFIG.maxContextChars);
          const prompt = buildMedicalPrompt(clinicalQuery, context);
          const model = await getChatModel();
          const response = await model.stream(prompt);
          let modelText = "";

          for await (const chunk of response) {
            const text = chunkToText(chunk);
            if (text) modelText += text;
          }

          write(cleanAssistantOutput(modelText) || "The internal clinical guideline does not provide enough context to answer that safely.");

          await saveChatMessageBestEffort(sessionId, userId, "assistant", assistantText);
          controller.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : "The LangChain clinical workflow failed.";
          controller.enqueue(encoder.encode(`\n\n${message}`));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    return streamError(message, 502);
  }
}
