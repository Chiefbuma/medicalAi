import type { Document } from "@langchain/core/documents";
import { normalizeClinicalQueryText } from "@/lib/rag/semantic-normalizer";

export const MEDICAL_SYSTEM_PROMPT = `You are a clinical guideline assistant.

Use only the provided clinical guideline context from the internal clinical guideline. Do not use the internet, external sources, or general medical memory. If the answer is not supported by the provided context, say that the information is not available in the internal clinical guideline and advise the user to consult a qualified medical professional.

Rules:
1. Do not invent diagnoses, medication doses, contraindications, or procedures.
2. If the user describes bleeding with dizziness, fainting, confusion, weakness, severe pallor, fast breathing, weak pulse, low blood pressure, pregnancy, miscarriage, postpartum bleeding, trauma, or heavy ongoing blood loss, start with an urgent triage statement before any explanation.
3. Do not assume the bleeding source. If the user only says "woman has bleeding", say the source is unclear and ask about vaginal bleeding, pregnancy/postpartum status, injury, vomiting/coughing blood, stool/urine blood, amount, and duration.
4. Highlight danger signs, red flags, emergencies, or urgent referral criteria when present in the context.
5. In the Source section, refer only to "Internal clinical guideline" with section, line/chunk, and retrieval score when available. Do not list PDF filenames.
6. Keep answers clinically structured and concise.
7. Do not misread vital signs. A blood pressure like X/Y has systolic X and diastolic Y. Do not call it hypotension unless the systolic or diastolic value is actually low according to the provided context.
8. This is decision support, not a replacement for a clinician.
9. Use same-session case memory as the current patient facts. Newer facts override older facts. If deterministic preprocessing or same-session memory marks a fact as absent with high certainty, do not override it unless the doctor clearly corrects it. For example, "Patient denies vomiting, but reports nausea" means vomiting is absent and nausea is present.
10. If the doctor asks a conversational question such as "what do you mean?", "is that true?", "where?", "which?", or "why?", answer in simple clinical language using the current case and guideline context. If the reference is unclear, ask one leading clarification question.
11. If negation is ambiguous, such as "likely no fever" or "probably not vomiting", do not force a pathway change from that fact alone. Ask a focused clarification question or state that the fact is uncertain.
12. If the doctor may be moving to a new patient or different presentation, ask whether this is the same patient before changing the pathway.
13. Do not write meta commentary about the user, prompt, or your reasoning. Never start with phrases such as "Since the user", "The user", "Based on the context provided", or "I will".`;

export function extractBloodPressure(question: string) {
  const match = question.match(/\b(\d{2,3})\s*\/\s*(\d{2,3})\b/);
  if (!match) return null;

  return {
    systolic: Number(match[1]),
    diastolic: Number(match[2]),
  };
}

function formatSources(documents: Document[]) {
  const sources: string[] = [];

  for (const doc of documents) {
    const metadata = doc.metadata as Record<string, unknown>;
    const section = String(metadata.sectionNumber || inferSectionNumber(doc.pageContent) || "not indexed");
    const line =
      typeof metadata.lineNumber === "number"
        ? metadata.lineNumber
        : typeof metadata.startLine === "number"
          ? metadata.startLine
          : typeof metadata.chunkIndex === "number"
            ? metadata.chunkIndex + 1
            : "not indexed";
    const score = typeof metadata.score === "number" ? metadata.score.toFixed(3) : "not available";
    const source = `Internal clinical guideline, section ${section}, line/chunk ${line}, score ${score}`;
    if (sources.includes(source)) continue;
    sources.push(source);
  }

  return sources.slice(0, 3).join("; ") || "Internal clinical guideline, section not indexed, line/chunk not indexed, score not available";
}

function formatAsthmaSources(documents: Document[]) {
  const asthmaDocuments = documents.filter((doc) => {
    const content = doc.pageContent.toLowerCase();
    const metadata = doc.metadata as Record<string, unknown>;
    const section = String(metadata.sectionNumber || inferSectionNumber(doc.pageContent) || "");
    return (
      section.startsWith("8") ||
      /asthma|asthmatic attack|wheeze|pulsus paradoxus|salbutamol|ipratropium|hydrocortisone/.test(content)
    );
  });

  return formatSources(asthmaDocuments.length ? asthmaDocuments : documents);
}

function inferSectionNumber(content: string) {
  const lower = content.toLowerCase();
  const direct = content.match(/(?:^|\n)\s*(\d+(?:\.\d+){0,3})\s+[A-Z]/)?.[1];
  if (direct) return direct;

  const sectionHints: Array<[string, RegExp]> = [
    ["1", /per vaginal bleeding|pv bleeding|antepartum haemorrhage|abortion complicated/],
    ["2", /hotness of body|acute fever|malaria antigen|fever with|otitis media|urinary tract infection/],
    ["3", /blood pressure in pregnancy|pre-?eclampsia|methyldopa|magnesium sulphate|target organ damage/],
    ["4", /head injury|glasgow coma|gcs|ct scan of the head/],
    ["5", /abdominal injury|abdominal trauma|fast ultrasound/],
    ["6", /chest trauma|pneumothorax|haemothorax|percussion note/],
    ["7", /epigastric pain|bloody vomitus|h\.?\s*pylori|esomeprazole/],
    ["8", /asthma|asthmatic attack|wheeze|pulsus paradoxus|salbutamol|hydrocortisone/],
    ["9", /burn injury|burns|tbsa|silver sulfadiazine/],
    ["10", /hyperkalaemia|hyperkalemia|potassium|calcium gluconate|polystyrene sulphonate/],
    ["12", /diabetic ketoacidosis|\bdka\b|kussmaul|ketones|insulin/],
    ["13", /fluid management|plan a|plan b|plan c|oral rehydration|zinc sulphate/],
    ["14", /hypernatraemia|hypernatremia|half-strength darrow|sodium above 150/],
    ["15", /hyponatraemia|hyponatremia|hypertonic saline|sodium below 130/],
    ["Appendix", /postpartum haemorrhage|postpartum hemorrhage|pph|placenta praevia/],
  ];

  return sectionHints.find(([, pattern]) => pattern.test(lower))?.[0];
}

export function buildBloodPressureGuardedAnswer(question: string, documents: Document[]) {
  const bloodPressure = extractBloodPressure(question);
  if (!bloodPressure) return null;

  const lowerQuestion = question.toLowerCase();
  const hasOtherSymptoms =
    /bleed|dizz|faint|confus|weak|pallor|breath|chest|headache|blur|epigastric|seiz|pregnan|postpartum/.test(
      lowerQuestion,
    );

  if (hasOtherSymptoms) return null;

  const sourceText = documents.map((doc) => doc.pageContent).join("\n").toLowerCase();
  const hasHypertensionContext = /hypertension|pre-?eclampsia|160\s*\/\s*110|blood pressure/.test(sourceText);
  const sources = formatSources(documents);

  if (!hasHypertensionContext) {
    return `Urgency: The internal clinical guideline context retrieved for this question does not provide enough context to interpret blood pressure ${bloodPressure.systolic}/${bloodPressure.diastolic}.

would you  check the following?
- Repeat the blood pressure measurement and confirm the cuff size/position.
- Ask about symptoms and clinical context, especially pregnancy status if relevant.

Possible  diagnosis based on the clinical guidlines
- Not available in the retrieved internal clinical guideline context.

Source:
${sources}`;
  }

  return `Urgency: Blood pressure ${bloodPressure.systolic}/${bloodPressure.diastolic} should not be described as hypotension. The retrieved internal clinical guideline context discusses high blood pressure/severe hypertension thresholds, including 160/110 in pregnancy-related guidance, so this needs clinical review in context rather than shock management from the BP alone.

would you  check the following?
- Repeat the blood pressure measurement and confirm the reading.
- Ask whether the patient is pregnant or postpartum; if pregnant, ask gestational age.
- Check for target-organ or pre-eclampsia symptoms mentioned in the internal clinical guideline context, such as severe headache, blurred vision, epigastric pain, oliguria, liver tenderness, seizure, confusion, chest pain, or breathlessness.

Possible  diagnosis based on the clinical guidlines
- The retrieved internal clinical guideline context points toward hypertension/pre-eclampsia assessment rather than hypotension. Use the guideline threshold and clinical context before deciding urgency or treatment.

Source:
${sources}`;
}

export function buildRetrievalQuery(question: string) {
  const corrected = question.replace(/\bpresu+re\b/gi, "pressure").replace(/\bbp\b/gi, "blood pressure");
  const semantic = normalizeClinicalQueryText(corrected);
  const normalized = semantic && semantic !== corrected.toLowerCase().trim() ? `${corrected}\n${semantic}` : corrected;
  const bloodPressure = extractBloodPressure(normalized);

  if (/asthma|asmatic|asthmatic|wheeze|wheez|pulsus|paradoxus|end-?expiration|respiratory distress/i.test(normalized)) {
    return [
      normalized,
      "asthma attack severity mild moderate severe wheeze end expiratory pulse rate pulsus paradoxus accessory muscles respiratory failure",
    ].join("\n");
  }

  if (/pneumonia|fast breathing|difficult breathing|difficulty breathing|chest indrawing/i.test(normalized)) {
    return [
      normalized,
      "hotness of body fever pneumonia child over 60 days very severe pneumonia severe pneumonia non-severe pneumonia danger signs chest indrawing tachypnoea ability to feed oxygen amoxicillin clavulanate paracetamol",
    ].join("\n");
  }

  if (!bloodPressure) return normalized;

  return [
    normalized,
    "blood pressure hypertension high diastolic systolic pregnancy pre-eclampsia severe hypertension target organ damage",
    `systolic ${bloodPressure.systolic} diastolic ${bloodPressure.diastolic}`,
  ].join("\n");
}

function hasAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

type AsthmaBranch = "mild" | "moderate" | "severe" | "respiratory_failure";

type AsthmaFeatures = {
  mildFeatures: boolean[];
  moderateFeatures: boolean[];
  severeFeatures: boolean[];
  failureFeatures: boolean;
};

function firstNumberAfter(text: string, label: RegExp) {
  const labelMatch = text.match(label);
  if (!labelMatch?.index && labelMatch?.index !== 0) return null;

  const afterLabel = text.slice(labelMatch.index + labelMatch[0].length, labelMatch.index + labelMatch[0].length + 80);
  const numberMatch = afterLabel.match(/\b(\d+(?:\.\d+)?)\b/);
  return numberMatch ? Number(numberMatch[1]) : null;
}

function positiveAccessoryMuscleUse(text: string) {
  if (/no use of accessory muscles|no accessory muscle|without accessory muscle/.test(text)) return false;
  return hasAny(text, [
    /use of accessory muscles is present/,
    /using accessory muscles/,
    /accessory muscles present/,
    /accessory muscle use present/,
    /with accessory muscle use/,
    /accessory muscle retractions/,
  ]);
}

function asthmaFeaturesFor(text: string): AsthmaFeatures {
  const pulse = firstNumberAfter(text, /\bpulse(?:\s+rate)?(?:\s+is|\s+of|:)?\s*/);
  const pulsus = firstNumberAfter(text, /\bpulsus paradoxus(?:\s+is|\s+of|:)?\s*/);
  const pulseBelow100 = /pulse(?:\s+rate)?.{0,30}(?:below|<)\s*100/.test(text);
  const pulseAbove120 = /pulse(?:\s+rate)?.{0,30}(?:above|>)\s*120/.test(text);
  const pulsusBelow10 = /pulsus paradoxus.{0,40}(?:absent|below|<)\s*10?/.test(text);
  const mildPulse = pulseBelow100 || (pulse !== null && !pulseAbove120 && pulse < 100);
  const moderatePulse = pulse !== null && !pulseBelow100 && !pulseAbove120 && pulse >= 100 && pulse <= 120;
  const severePulse = pulseAbove120 || (pulse !== null && pulse > 120);
  const mildPulsus = pulsusBelow10 || (pulsus !== null && pulsus < 10);
  const moderatePulsus = pulsus !== null && !pulsusBelow10 && pulsus >= 10 && pulsus < 25;
  const severePulsus = pulsus !== null && !pulsusBelow10 && pulsus >= 25;

  return {
    mildFeatures: [
      hasAny(text, [/normal mental state/, /mental state is stable/, /talk.*sentences/, /no use of accessory muscles/, /no accessory muscle/]),
      hasAny(text, [/end-?expiration/, /end expiratory/, /only end/]),
      hasAny(text, [/pulse rate below 100/, /pulse rate <\s*100/, /pulse below 100/, /pulse <\s*100/]) || mildPulse,
      hasAny(text, [/pulsus paradoxus.*absent/, /pulsus paradoxus.*below 10/, /pulsus paradoxus.*<\s*10/]) || mildPulsus,
    ],
    moderateFeatures: [
      positiveAccessoryMuscleUse(text),
      hasAny(text, [/loud wheeze throughout exhalation/, /loud.*throughout.*exhalation/]),
      hasAny(text, [/pulse rate 100\s*(?:-|to)\s*120/, /pulse.*100\s*(?:-|to)\s*120/]) || moderatePulse,
      hasAny(text, [/pulsus paradoxus.*10\s*(?:-|to)\s*25/, /pulsus.*10.*25/]) || moderatePulsus,
    ],
    severeFeatures: [
      hasAny(text, [/sitting upright/, /agitat/]),
      hasAny(text, [/loud.*inhalation.*exhalation/, /loud.*inspiration.*exhalation/, /loud.*both inhalation and exhalation/]),
      hasAny(text, [/pulse rate >\s*120/, /pulse >\s*120/, /above 120/]) || severePulse,
      hasAny(text, [/pulsus paradoxus.*25/, /pulsus paradoxus.*20.*40/]) || severePulsus,
    ],
    failureFeatures: hasAny(text, [
      /drows/,
      /confus/,
      /paradoxical thoracoabdominal/,
      /absence of wheeze/,
      /silent chest/,
      /bradycardia/,
    ]),
  };
}

function asthmaBranchFromNamedRequest(text: string): AsthmaBranch | null {
  if (/actual or impending respiratory failure|respiratory failure/.test(text)) return "respiratory_failure";
  if (/severe asthmatic attack|severe asthma/.test(text)) return "severe";
  if (/moderate asthmatic attack|moderate asthma/.test(text)) return "moderate";
  if (/mild asthmatic attack|mild asthma/.test(text)) return "mild";
  return null;
}

function asthmaBranchFromFeatures(features: AsthmaFeatures): AsthmaBranch | null {
  if (features.failureFeatures) return "respiratory_failure";
  if (features.severeFeatures.some(Boolean)) return "severe";
  if (features.moderateFeatures.some(Boolean)) return "moderate";
  if (features.mildFeatures.every(Boolean)) return "mild";
  return null;
}

function latestAsthmaBranchFromConversation(text: string): AsthmaBranch | null {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:-\s*)?(?:current doctor message:\s*)?/i, "").trim())
    .filter(Boolean);

  for (const line of lines.reverse()) {
    if (asksForAsthmaManagement(line) && !asthmaBranchFromNamedRequest(line)) continue;
    const branch = asthmaBranchFromNamedRequest(line) || asthmaBranchFromFeatures(asthmaFeaturesFor(line));
    if (branch) return branch;
  }

  return null;
}

function asksForAsthmaManagement(text: string) {
  return /manage|mange|management|managment|treat|treatment|therapy|medication|administer/.test(text);
}

function asthmaManagementBody(branch: AsthmaBranch) {
  const managementByBranch: Record<AsthmaBranch, string> = {
    mild: `Management and medication guidance:
- Give nebulised salbutamol: age 1 month to 11 years, 2.5 mg; over 11 years, 5 mg. Repeat up to 3 doses in the first hour if needed.
- Give oral prednisolone 1 mg/kg daily for 7 days.
- Arrange follow-up in 24 hours and reassess sooner if symptoms worsen.

Recommended disposition:
outpatient`,
    moderate: `Management and medication guidance:
- Admit for repeated nebulised salbutamol.
- Give IV ipratropium 200 micrograms.
- Give IV hydrocortisone: age 1 to 5 years, 50 mg; age 6 to 12 years, 100 mg.
- Call the physician immediately.

Recommended disposition:
admit`,
    severe: `Management and medication guidance:
- Admit for intensive nebulised salbutamol.
- Give IV ipratropium.
- Give IV hydrocortisone.
- Obtain blood gas analysis.
- Call the physician immediately.

Recommended disposition:
admit`,
    respiratory_failure: `Management and medication guidance:
- Admit to a critical care area for possible intubation.
- Intubate if necessary.
- Give aggressive bronchodilator and steroid therapy.
- Call the physician immediately.

Recommended disposition:
critical care / emergency escalation`,
  };

  return managementByBranch[branch];
}

function formatAsthmaManagement(branch: AsthmaBranch, sources: string) {
  const introByBranch: Record<AsthmaBranch, string> = {
    mild: "For this mild asthmatic attack pathway, the internal clinical guideline recommends outpatient management.",
    moderate: "For this moderate asthmatic attack pathway, the internal clinical guideline recommends admission and urgent clinician review.",
    severe: "For this severe asthmatic attack pathway, the internal clinical guideline recommends admission and urgent escalation.",
    respiratory_failure:
      "For actual or impending respiratory failure in asthma, the internal clinical guideline recommends critical-care level management.",
  };

  return `${introByBranch[branch]}

${asthmaManagementBody(branch)}

Source:
${sources}`;
}

export function buildAsthmaSeverityGuardedAnswer(question: string, documents: Document[], currentQuestion = question) {
  const lowerQuestion = question.toLowerCase();
  const currentLowerQuestion = currentQuestion.toLowerCase();
  const looksLikeAsthmaSeverity = /asthma|asmatic|asthmatic|wheeze|wheez|pulsus|paradoxus|end-?expiration|respiratory/.test(
    lowerQuestion,
  );
  if (!looksLikeAsthmaSeverity) return null;

  const sourceText = documents.map((doc) => doc.pageContent).join("\n").toLowerCase();
  const hasAsthmaContext = /mild asthmatic attack|moderate asthmatic attack|severe asthmatic attack|pulsus paradoxus|end expiratory|end-expiratory/.test(
    sourceText,
  );

  if (!hasAsthmaContext) return null;

  const currentFeatures = asthmaFeaturesFor(currentLowerQuestion);
  const historyFeatures = asthmaFeaturesFor(lowerQuestion);
  const currentBranch = asthmaBranchFromFeatures(currentFeatures);
  const contextualBranch =
    asthmaBranchFromNamedRequest(currentLowerQuestion) ||
    currentBranch ||
    latestAsthmaBranchFromConversation(lowerQuestion) ||
    asthmaBranchFromFeatures(historyFeatures);
  const mildFeatures = currentFeatures.mildFeatures;
  const moderateFeatures = currentFeatures.moderateFeatures;
  const severeFeatures = currentFeatures.severeFeatures;
  const failureFeatures = currentFeatures.failureFeatures;
  const hasSeverityFeature = mildFeatures.some(Boolean) || moderateFeatures.some(Boolean) || severeFeatures.some(Boolean) || failureFeatures;
  const sources = formatAsthmaSources(documents);
  const currentAsthmaSymptomsNegated =
    /no respiratory distress|without respiratory distress|wheez\w*.{0,20}(?:absent|resolved|stopped|not present)|(?:no|not|without)\s+wheez\w*/.test(
      currentLowerQuestion,
    );

  if (asksForAsthmaManagement(currentLowerQuestion)) {
    if (contextualBranch) return formatAsthmaManagement(contextualBranch, sources);

    return `I can give the asthma management from the internal clinical guideline, but I need the severity branch first.

For an asthmatic patient, please confirm:
- Mental state and ability to speak
- Accessory muscle use
- Wheeze pattern
- Pulse rate
- Pulsus paradoxus, if available

Once you answer, I will match the mild, moderate, severe, or respiratory failure branch and give management.

Source:
${sources}`;
  }

  if (currentAsthmaSymptomsNegated && !failureFeatures && !severeFeatures.some(Boolean) && !moderateFeatures.some(Boolean)) {
    return `I am treating this as an update to the same asthma presentation, but the newest details say wheeze or respiratory distress is absent/resolved. I cannot classify an active asthma attack severity branch from that alone.

would you  check the following?
- Is the patient currently symptomatic, or are you saying the previous wheeze has resolved?
- Current oxygen saturation
- Ability to speak and mental state
- Current wheeze pattern, if any
- Pulse rate and pulsus paradoxus, if available

Possible  diagnosis based on the clinical guidlines
- Active asthma attack severity is not confirmed from the current negative findings alone. If wheeze is absent because the chest is silent with distress, that may be dangerous; if symptoms have resolved and the patient is stable, say that clearly.

Source:
${sources}`;
  }

  if (failureFeatures) {
    return `Urgency: Critical. The retrieved internal clinical guideline context links drowsiness/confusion, paradoxical thoracoabdominal movement, absence of wheeze, bradycardia, or absent pulsus paradoxus in this setting with actual or impending respiratory failure.

would you  check the following?
- Oxygen saturation, ability to speak, mental status, respiratory effort, pulse, and pulsus paradoxus.
- Look for silent chest, exhaustion, confusion, bradycardia, or paradoxical thoracoabdominal movement.

Possible  diagnosis based on the clinical guidlines
- Actual or impending respiratory failure in asthma.

${asthmaManagementBody("respiratory_failure")}

Source:
${sources}`;
  }

  if (mildFeatures.every(Boolean) && !severeFeatures.some(Boolean)) {
    return `Urgency: This feature set matches the mild asthmatic attack branch in the internal clinical guideline, not severe asthma.

would you  check the following?
- Confirm the patient can talk in sentences, is alert, can lie down, has no accessory muscle use, and has stable oxygen saturation.
- Recheck pulse rate, respiratory rate, oxygen saturation, wheeze pattern, and pulsus paradoxus.
- Escalate if symptoms worsen, oxygen saturation is low, accessory muscles are used, the patient cannot speak normally, or mental status changes.

Possible  diagnosis based on the clinical guidlines
- Mild asthmatic attack: wheeze often only end-expiratory, pulse rate below 100, and pulsus paradoxus absent or below 10 mm Hg.

${asthmaManagementBody("mild")}

Source:
${sources}`;
  }

  if (moderateFeatures.some(Boolean) && !severeFeatures.some(Boolean)) {
    return `Urgency: Urgent. The newest details match the moderate asthmatic attack branch in the internal clinical guideline.

would you  check the following?
- Confirm accessory muscle use, wheeze pattern, pulse rate, pulsus paradoxus, oxygen saturation, and mental status.
- Reassess for severe features: sitting upright, agitation, loud wheeze during both inhalation and exhalation, pulse above 120, or high pulsus paradoxus.

Possible  diagnosis based on the clinical guidlines
- Moderate asthmatic attack: loud wheeze throughout exhalation, pulse rate 100 to 120 beats per minute, or pulsus paradoxus 10 to 25 mm Hg.

${asthmaManagementBody("moderate")}

Source:
${sources}`;
  }

  if (severeFeatures.some(Boolean)) {
    return `Urgency: Severe or potentially severe asthma features are present in the retrieved internal clinical guideline context; assess urgently and escalate according to the guideline.

would you  check the following?
- Ability to speak, oxygen saturation, accessory muscle use, mental status, pulse rate, respiratory effort, and pulsus paradoxus.

Possible  diagnosis based on the clinical guidlines
- Severe asthmatic attack if features such as loud wheeze in inspiration and exhalation, pulse above 120, marked distress, or high pulsus paradoxus are present.

${asthmaManagementBody("severe")}

Source:
${sources}`;
  }

  if (!hasSeverityFeature) {
    return `I can help classify this using the internal clinical guideline, but I need a few details before deciding the asthma severity branch.

For an asthmatic patient, please confirm:
- Mental state and ability to speak
- Accessory muscle use
- Wheeze pattern
- Pulse rate
- Pulsus paradoxus, if available

Once you answer, I will match the mild, moderate, severe, or respiratory failure branch.

Source:
${sources}`;
  }

  return null;
}

export function formatContext(documents: Document[], maxChars: number) {
  let used = 0;
  const parts: string[] = [];

  for (const [index, doc] of documents.entries()) {
    const metadata = doc.metadata as Record<string, unknown>;
    const line =
      typeof metadata.lineNumber === "number"
        ? metadata.lineNumber
        : typeof metadata.startLine === "number"
          ? metadata.startLine
          : typeof metadata.chunkIndex === "number"
            ? metadata.chunkIndex + 1
            : "not indexed";
    const source = [
      "Internal clinical guideline",
      `section ${String(metadata.sectionNumber || inferSectionNumber(doc.pageContent) || "not indexed")}`,
      `line/chunk ${line}`,
      typeof metadata.score === "number" ? `score ${metadata.score.toFixed(3)}` : "score not available",
    ].join(", ");
    const header = `[Source ${index + 1}${source ? `: ${source}` : ""}]`;
    const content = `${header}\n${doc.pageContent.trim()}`;

    if (used + content.length > maxChars) break;

    parts.push(content);
    used += content.length;
  }

  return parts.join("\n\n---\n\n");
}

export function buildMedicalPrompt(question: string, context: string) {
  const lowerQuestion = question.toLowerCase();
  const bloodPressure = extractBloodPressure(question);
  const vagueBleeding =
    lowerQuestion.includes("bleeding") &&
    !/\bvaginal\b|\buterine\b|\bperiod\b|\bpregnan|\bpostpartum\b|\bbirth\b|\bmiscarriage\b|\bstool\b|\burine\b|\bvomit|\bcough|\binjury\b|\btrauma\b|\bwound\b/.test(
      lowerQuestion,
    );
  const safetyInstruction = vagueBleeding
    ? 'The user mentioned bleeding but did not identify the source. Your first line must be: "Urgency: Bleeding with dizziness can indicate significant blood loss or shock. Seek urgent or emergency medical assessment now, especially if bleeding is heavy, ongoing, or the patient feels faint, confused, weak, very pale, short of breath, or has a fast/weak pulse." Do not state or imply uterine/vaginal bleeding as the diagnosis. Say the bleeding source is unclear, list urgent danger signs, and ask clarifying questions about the bleeding source. You may mention that one retrieved guideline source discusses uterine blood loss only as an example to consider if the bleeding is vaginal.'
    : "";
  const bloodPressureInstruction = bloodPressure
    ? `The user gave blood pressure ${bloodPressure.systolic}/${bloodPressure.diastolic}. Treat ${bloodPressure.systolic} as systolic and ${bloodPressure.diastolic} as diastolic. Your first line must not be blank. If diastolic is ${bloodPressure.diastolic}, do not call this hypotension and do not say shock is indicated by this blood pressure alone. For a blood-pressure-only question, do not ask about bleeding, injury, vomiting blood, stool blood, or urine blood unless the user mentioned those symptoms. If the provided internal clinical guideline context has thresholds for high blood pressure, severe hypertension, pregnancy, pre-eclampsia, or target organ damage, use those thresholds exactly. Ask only BP-relevant checks such as repeat measurement, pregnancy status when relevant to the source, gestation if pregnant, severe headache, blurred vision, epigastric pain, oliguria, liver tenderness, seizures, chest pain, breathlessness, weakness, or confusion if supported by context. If the internal clinical guideline context does not support interpretation, say it does not provide enough context to interpret this blood pressure.`
    : "";

  return `${MEDICAL_SYSTEM_PROMPT}

Context:
${context || "No relevant guideline context was retrieved."}

User question:
${question}

${safetyInstruction ? `Case-specific safety instruction:\n${safetyInstruction}\n` : ""}
${bloodPressureInstruction ? `Vital-sign safety instruction:\n${bloodPressureInstruction}\n` : ""}

Answer from the context only.

Response format:
- Start with "Urgency:" if the presentation may be unstable or needs same-day/emergency assessment.
- Then give "would you  check the following?", "Possible  diagnosis based on the clinical guidlines", and "Source:" sections.
- If the question is vague, ask the minimum key clarifying questions after the urgent advice.`;
}
