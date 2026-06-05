import type { Document } from "@langchain/core/documents";
import {
  getPathwayDetailsByTitle,
  listPathwayNodes,
  type PathwayDetails,
  type PathwayNode,
} from "@/lib/chat-store";
import { booleanConcept } from "@/lib/rag/clinical-negation";
import { normalizeClinicalQueryText } from "@/lib/rag/semantic-normalizer";

type GuardResult = {
  condition: string;
  branch: string;
  severity: "routine" | "urgent" | "critical";
  disposition: string;
  summary: string;
  management?: string;
  sourceSection: string;
  missing?: string[];
};

type GuardRule = GuardResult & {
  conditionPattern: RegExp;
  match: (text: string) => boolean;
};

const SHOCK = /shock|faint|collapse|confus|altered consciousness|unconscious|weak thready pulse|systolic.*<\s*90|sbp\s*<\s*90|cold|clammy|severe pallor|dizz/;
const STABLE = /haemodynamically stable|hemodynamically stable|stable patient|patient is stable|no signs of shock|without signs of shock|not in shock/;
const PREGNANT = /pregnan|gestation|weeks pregnant|antenatal/;
const ACTIVE_BLEEDING = /active bleeding|ongoing bleeding|still bleeding|heavy bleeding|continued bleeding/;
const RESOLVED_BLEEDING = /resolved|stopped bleeding|bleeding stopped|bleeding has stopped|no active bleeding|no bleeding|bleeding resolved/;
const TARGET_ORGAN = /severe headache|blurred vision|epigastric pain|oliguria|liver tenderness|seizure|convulsion|target organ/;
const NEURO = /confus|hallucinat|abnormal postur|seizure|convulsion|reduced consciousness|unconscious/;
const PV_BLEEDING = /vaginal bleeding|pv bleeding|per vaginal|uterine bleeding|antepartum|abortion|bleeding/;
const NOT_PREGNANT = /not pregnant|non-pregnant|non pregnant|pregnancy test negative|negative pregnancy test/;
const NO_TARGET_ORGAN = /no target organ|without target organ|no severe headache|no blurred vision|no epigastric pain|no oliguria|no seizure|no convulsion/;
const NO_NEURO = /no confusion|not confused|normal mental state|alert|conscious|no seizure|no convulsion|no reduced consciousness|without neurological symptoms|no neurological symptoms/;
const NO_FEVER = /no fever|afebrile|not febrile|no hotness/;
const NO_RESPIRATORY = /no fast breathing|no difficult breathing|no difficulty breathing|no chest indrawing|breathing normal|normal breathing|no wheez\w*/;
const NO_URINARY = /no dysuria|no urinary symptoms|no flank pain|no suprapubic pain|no haematuria|no hematuria/;
const NO_EAR_PAIN = /no ear pain|no otitis|no ear discharge|no otorrhoea/;
const NO_VOMITING = /no vomit\w*|not vomit\w*|denies vomit\w*|denied vomit\w*/;
const NO_BLOODY_VOMITUS = /no bloody vomit|no blood in vomit|no haematemesis|no hematemesis/;

function has(text: string, pattern: RegExp) {
  return pattern.test(text);
}

function normalizeClinicalText(text: string) {
  const base = text
    .toLowerCase()
    .replace(/full-thickness/g, "full thickness")
    .replace(/partial-thickness/g, "partial thickness")
    .replace(/end-expiration/g, "end expiration")
    .replace(/hyper-resonant/g, "hyper resonant")
    .replace(/\s+/g, " ")
    .trim();
  const semantic = normalizeClinicalQueryText(base);
  return semantic && semantic !== base ? `${base} ${semantic}` : base;
}

function numberAfter(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  if (!match?.[1]) return null;
  return Number(match[1]);
}

type Comparator = "lt" | "lte" | "gt" | "gte" | "eq";
type NumericMention = { value: number; comparator: Comparator };

function comparatorFromText(text: string | undefined): Comparator {
  const token = (text || "").trim().toLowerCase();
  if (/^(?:<|less than|below|under|lower than)$/.test(token)) return "lt";
  if (/^(?:<=|≤|less than or equal to|at most|not more than|up to)$/.test(token)) return "lte";
  if (/^(?:>|more than|above|over|greater than|exceeding|higher than)$/.test(token)) return "gt";
  if (/^(?:>=|≥|more than or equal to|at least|not less than)$/.test(token)) return "gte";
  return "eq";
}

function firstNumberMention(text: string, patterns: RegExp[]): NumericMention | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const numberText = match.groups?.value || match[2] || match[1];
    const value = Number(numberText);
    if (!Number.isFinite(value)) continue;
    const comparatorText = match.groups?.comparator || match[1];
    return { value, comparator: comparatorFromText(comparatorText) };
  }

  return null;
}

function mentionMatchesRule(mention: NumericMention | null, rule: Record<string, unknown>) {
  if (!mention) return null;
  const { value, comparator } = mention;

  if (typeof rule.lt === "number") {
    if (value < rule.lt) return true;
    if (value === rule.lt && (comparator === "lt" || comparator === "lte")) return true;
    return false;
  }

  if (typeof rule.gt === "number") {
    if (value > rule.gt) return true;
    if (value === rule.gt && (comparator === "gt" || comparator === "gte")) return true;
    return false;
  }

  if (typeof rule.lte === "number" && typeof rule.gte === "number") {
    if ((comparator === "lt" || comparator === "lte") && value <= rule.gte) return false;
    if ((comparator === "gt" || comparator === "gte") && value >= rule.lte) return false;
    if (comparator !== "eq") return null;
    if (value >= rule.gte && value <= rule.lte) return true;
    return false;
  }

  if (typeof rule.lte === "number") {
    if (value <= rule.lte) return true;
    if (value === rule.lte && comparator === "lt") return true;
    return false;
  }

  if (typeof rule.gte === "number") {
    if (value >= rule.gte) return true;
    if (value === rule.gte && comparator === "gt") return true;
    return false;
  }

  return null;
}

function gcs(text: string) {
  return gcsMention(text)?.value ?? null;
}

function gcsMention(text: string) {
  return firstNumberMention(text, [
    /\bgcs\s*(<=|>=|<|>|≤|≥|less than or equal to|more than or equal to|less than|below|under|more than|above|over|greater than|at least|equal to|=|is|:)?\s*(\d{1,2})\b/,
    /(<=|>=|<|>|≤|≥|less than or equal to|more than or equal to|less than|below|under|more than|above|over|greater than|at least)\s*(\d{1,2})\s*gcs\b/,
  ]);
}

function weeks(text: string) {
  return weeksMention(text)?.value ?? null;
}

function weeksMention(text: string) {
  if (!/pregnan|gestation|gestational|antenatal|weeks pregnant/.test(text)) return null;

  return firstNumberMention(text, [
    /(<=|>=|<|>|≤|≥|less than or equal to|more than or equal to|less than|below|under|more than|above|over|greater than|at least|equal to)?\s*(\d{1,2})\s*(?:weeks|wks)/,
    /(?:gestation|gestational age).*?(<=|>=|<|>|≤|≥|less than or equal to|more than or equal to|less than|below|under|more than|above|over|greater than|at least|equal to|is|=|:)?\s*(\d{1,2})/,
  ]);
}

function gestationOver20Weeks(text: string) {
  const mention = weeksMention(text);
  if (!mention) return false;
  return mentionMatchesRule(mention, { gt: 20 }) === true || mention.value >= 20;
}

function gestationUnder20Weeks(text: string) {
  const mention = weeksMention(text);
  if (!mention) return false;
  return mentionMatchesRule(mention, { lt: 20 }) === true || mention.value < 20;
}

function ageYears(text: string) {
  return ageYearsMention(text)?.value ?? null;
}

function ageYearsMention(text: string) {
  return firstNumberMention(text, [
    /(?:age|aged)?\s*(<=|>=|<|>|≤|≥|less than|under|below|more than|above|over|greater than|at least)?\s*(\d{1,3})\s*(?:years|year|yrs|yr)\b/,
    /(?:age|aged)\s*(<=|>=|<|>|≤|≥|less than|under|below|more than|above|over|greater than|at least|is|=|:)?\s*(\d{1,3})\b/,
  ]);
}

function ageMonths(text: string) {
  const explicitMonths = numberAfter(text, /(?:age|aged|old|is)?\s*(\d{1,2})\s*(?:months|month|mos|mo)\b/);
  if (explicitMonths !== null) return explicitMonths;

  const weeksValue = ageWeeks(text);
  return weeksValue !== null ? Math.floor(weeksValue / 4.345) : null;
}

function ageDays(text: string) {
  const explicitDays = firstNumberMention(text, [
    /(?:child|boy|girl|infant|baby|neonate|newborn|age|aged|old|is)?\s*(?:is|=|:)?\s*(<=|>=|<|>|≤|≥|less than|below|under|more than|above|over|greater than|at least|equal to)?\s*(\d{1,3})\s*(?:days|day)\b/,
  ]);
  if (explicitDays) return explicitDays.value;

  const weeksMentionValue = ageWeeksMention(text);
  return weeksMentionValue ? Math.ceil(weeksMentionValue.value * 7) : null;
}

function ageDaysMention(text: string): NumericMention | null {
  const explicitDays = firstNumberMention(text, [
    /(?:child|boy|girl|infant|baby|neonate|newborn|age|aged|old|is)?\s*(?:is|=|:)?\s*(<=|>=|<|>|≤|≥|less than|below|under|more than|above|over|greater than|at least|equal to)?\s*(\d{1,3})\s*(?:days|day)\b/,
  ]);
  if (explicitDays) return explicitDays;

  const weeksMentionValue = ageWeeksMention(text);
  if (!weeksMentionValue) return null;
  return {
    value: Math.ceil(weeksMentionValue.value * 7),
    comparator: weeksMentionValue.comparator,
  };
}

function ageWeeks(text: string) {
  return ageWeeksMention(text)?.value ?? null;
}

function ageWeeksMention(text: string) {
  if (!/child|boy|girl|infant|baby|neonate|newborn|paediatric|pediatric|age|aged|old/.test(text)) return null;
  if (/pregnan|gestation|gestational|antenatal|weeks pregnant/.test(text)) return null;

  return firstNumberMention(text, [
    /(?:age|aged|old|is)?\s*(<=|>=|<|>|≤|≥|less than|below|under|more than|above|over|greater than|at least|equal to)?\s*(\d{1,3})\s*(?:weeks|week|wks|wk)\b/,
  ]);
}

function durationDays(text: string) {
  return durationDaysMention(text)?.value ?? null;
}

function durationDaysMention(text: string) {
  return firstNumberMention(text, [
    /(?:duration|for|lasting|short duration|fever of short duration).*?(<=|>=|<|>|≤|≥|less than|below|under|more than|above|over|greater than|at least|is|=|:)?\s*(\d{1,3})\s*(?:days|day)\b/,
    /(<=|>=|<|>|≤|≥|less than|below|under|more than|above|over|greater than|at least)\s*(\d{1,3})\s*(?:days|day)\s*(?:duration|of fever|fever)/,
  ]);
}

function tbsa(text: string) {
  return tbsaMention(text)?.value ?? null;
}

function tbsaMention(text: string) {
  return firstNumberMention(text, [
    /(<=|>=|<|>|≤|≥|less than or equal to|more than or equal to|less than|below|under|more than|above|over|greater than|exceeding|at least)?\s*(\d{1,3})\s*%?\s*(?:tbsa|body surface|burn)/,
    /(?:tbsa|body surface).*?(<=|>=|<|>|≤|≥|less than or equal to|more than or equal to|less than|below|under|more than|above|over|greater than|exceeding|at least|is|=|:)?\s*(\d{1,3})\s*%?/,
    /(<=|>=|<|>|≤|≥|less than|below|under|more than|above|over|greater than|exceeding|at least)?\s*(\d{1,3})\s*%/,
  ]);
}

function burnDepthKnown(text: string) {
  return /superficial|partial thickness|full thickness|first degree|second degree|third degree/.test(text);
}

function specialAreaBurnKnown(text: string) {
  return /face|hand|hands|feet|foot|genitalia|perineum|major joints|joint|special area|no special|not.*(?:face|hand|feet|foot|genitalia|perineum|joint)|no.*(?:face|hand|feet|foot|genitalia|perineum|joint)/.test(
    text,
  );
}

function specialAreaBurnPresent(text: string) {
  const mentionsSpecialArea = /face|hand|hands|feet|foot|genitalia|perineum|major joints|joint|special area/.test(text);
  const negatesSpecialArea = /no special|not.*(?:face|hand|feet|foot|genitalia|perineum|joint)|no.*(?:face|hand|feet|foot|genitalia|perineum|joint)/.test(
    text,
  );
  return mentionsSpecialArea && !negatesSpecialArea;
}

function missingBurnFacts(text: string) {
  const missing: string[] = [];
  if (ageYears(text) === null) missing.push("age_years");
  if (!burnDepthKnown(text)) missing.push("burn_depth");
  if (tbsa(text) === null) missing.push("tbsa_percent");
  if (!specialAreaBurnKnown(text)) missing.push("special_area_burn");
  return missing;
}

function asksForTreatment(text: string) {
  return /treat|treatment|therapy|manage|manag|management|medication|medicine|drug|administer|give|dose|analges|pain|antibiotic|cream|ointment|fluid|insulin/.test(
    text,
  );
}

function asksForCompleteness(text: string) {
  return /\b(?:is that all|anything else|any other|what else|what more|only that|is there more|anything more)\b/.test(text);
}

function asksForDiagnostics(text: string) {
  return /\b(?:test|tests|investigation|investigations|investigate|diagnostic|diagnostics|lab|labs|laboratory|cbc|fbc|ultrasound|x-?ray|ct|scan|blood gas|urinalysis|cross-?match)\b/.test(
    text,
  ) || /what.*(?:recommended|recommend).*(?:check|send|order|do)/.test(text);
}

function asksForInsulin(text: string) {
  return /insulin/.test(text);
}

function potassium(text: string) {
  return potassiumMention(text)?.value ?? null;
}

function potassiumMention(text: string) {
  return firstNumberMention(text, [
    /(?:potassium|k\+?)\s*(<=|>=|<|>|≤|≥|less than|below|under|more than|above|over|greater than|at least|is|=|:)?\s*(\d+(?:\.\d+)?)/,
    /(<=|>=|<|>|≤|≥|less than|below|under|more than|above|over|greater than|at least)\s*(\d+(?:\.\d+)?)\s*(?:potassium|k\+?)/,
  ]);
}

function potassiumStatus(text: string) {
  if (/potassium.*(?:above normal|abnormal high|high|raised|elevated)|(?:above normal|high|raised|elevated).*potassium|hyperkalaemia|hyperkalemia/.test(text)) {
    return "above_normal";
  }

  return undefined;
}

function sodium(text: string) {
  return sodiumMention(text)?.value ?? null;
}

function sodiumMention(text: string) {
  return firstNumberMention(text, [
    /(?:sodium|na\+?)\s*(<=|>=|<|>|≤|≥|less than|below|under|more than|above|over|greater than|at least|is|=|:)?\s*(\d+(?:\.\d+)?)/,
    /(<=|>=|<|>|≤|≥|less than|below|under|more than|above|over|greater than|at least)\s*(\d+(?:\.\d+)?)\s*(?:sodium|na\+?)/,
  ]);
}

function bloodGlucose(text: string) {
  return bloodGlucoseMention(text)?.value ?? null;
}

function bloodGlucoseMention(text: string) {
  return firstNumberMention(text, [
    /(?:blood sugar|glucose|rbs)\s*(<=|>=|<|>|≤|≥|less than|below|under|more than|above|over|greater than|at least|is|=|:)?\s*(\d+(?:\.\d+)?)/,
  ]);
}

function ph(text: string) {
  return phMention(text)?.value ?? null;
}

function phMention(text: string) {
  return firstNumberMention(text, [
    /\bph\s*(<=|>=|<|>|≤|≥|less than|below|under|more than|above|over|greater than|at least|is|=|:)?\s*(\d+(?:\.\d+)?)/,
  ]);
}

function bicarbonate(text: string) {
  return bicarbonateMention(text)?.value ?? null;
}

function bicarbonateMention(text: string) {
  return firstNumberMention(text, [
    /(?:bicarbonate|hco3)\s*(<=|>=|<|>|≤|≥|less than|below|under|more than|above|over|greater than|at least|is|=|:)?\s*(\d+(?:\.\d+)?)/,
  ]);
}

function haemoglobinMention(text: string) {
  return firstNumberMention(text, [
    /(?:haemoglobin|hemoglobin|hb)\s*(<=|>=|<|>|≤|≥|less than|below|under|more than|above|over|greater than|at least|is|=|:)?\s*(\d+(?:\.\d+)?)/,
  ]);
}

function pphBloodLoss(text: string) {
  return pphBloodLossMention(text)?.value ?? null;
}

function pphBloodLossMention(text: string) {
  return firstNumberMention(text, [
    /(<=|>=|<|>|≤|≥|less than|below|under|more than|above|over|greater than|exceeding|at least)?\s*(\d{3,4})\s*(?:ml|millilit)/,
    /(?:blood loss|bleeding).*?(<=|>=|<|>|≤|≥|less than|below|under|more than|above|over|greater than|exceeding|at least|is|=|:)?\s*(\d{3,4})/,
  ]);
}

function hasBloodPressure(text: string) {
  return /\b\d{2,3}\s*\/\s*\d{2,3}\b/.test(text);
}

function bloodPressureMeets(
  bloodPressure: { systolic: number; diastolic: number } | undefined,
  threshold: string,
) {
  if (!bloodPressure) return null;
  const [systolic, diastolic] = threshold.split("/").map(Number);
  if (!Number.isFinite(systolic) || !Number.isFinite(diastolic)) return null;
  return bloodPressure.systolic >= systolic || bloodPressure.diastolic >= diastolic;
}

function hasSevereHypertension(facts: ExtractedFacts) {
  if (!facts.bloodPressure) return null;
  return facts.bloodPressure.systolic >= 160 || facts.bloodPressure.diastolic >= 110;
}

function hasMildHypertension(facts: ExtractedFacts) {
  if (!facts.bloodPressure) return null;
  const hypertensive = facts.bloodPressure.systolic >= 140 || facts.bloodPressure.diastolic >= 90;
  return hypertensive && !hasSevereHypertension(facts);
}

function detectConditionKeys(text: string) {
  const keys = new Set<string>();
  const patterns: Array<[string, RegExp]> = [
    ["pv_bleeding", /vaginal bleeding|pv bleeding|per vaginal|uterine bleeding|antepartum|abortion|miscarriage|pregnan.*bleed|bleed.*pregnan|gestation.*bleed|bleed.*gestation/],
    ["acute_fever", /fever|hotness|pyrexia|malaria|convulsion.*fever|ear pain|otitis|dysuria|urinary|pneumonia|fast breathing|difficult breathing/],
    ["bp_pregnancy", /pregnan.*(?:bp|blood pressure|hypertension|pre-?eclampsia)|(?:bp|blood pressure|hypertension|pre-?eclampsia).*pregnan/],
    ["head_injury", /head injur(?:y|ies)|head trauma|gcs|traumatic brain|csf otorrhoea|csf rhinorrhoea|injur(?:y|ies).*head|trauma.*head/],
    ["abdominal_injury", /abdominal injury|abdominal trauma|penetrating abdomen|blunt abdomen|abdominal wound/],
    ["chest_trauma", /chest trauma|chest injury|thoracic trauma|pneumothorax|haemothorax|hemothorax|hyper-?resonant|dull percussion/],
    ["epigastric_pain", /epigastric|upper abdominal|gastritis|peptic|h\.?\s*pylori|bloody vomit|haematemesis|hematemesis/],
    ["asthma_attack", /asthma|wheeze|wheez|pulsus|paradoxus|silent chest|bronchospasm/],
    ["burns", /burn|tbsa|scald|thermal|chemical|electrical|full thickness|partial thickness/],
    ["hyperkalaemia", /hyperkalaemia|hyperkalemia|potassium|high potassium|\bk\+?\b/],
    ["dka", /dka|diabetic ketoacidosis|ketone|kussmaul|polyuria|polydipsia|blood sugar|glucose/],
    ["paediatric_fluids", /dehydration|ors|plan a|plan b|plan c|diarrhoea|diarrhea|neonate fluid|newborn fluid/],
    ["hypernatraemia", /hypernatraemia|hypernatremia|high sodium|sodium.*(?:above|over|more than|greater than|>|>=|raised|elevated)/],
    ["hyponatraemia", /hyponatraemia|hyponatremia|low sodium|sodium.*(?:below|under|less than|<|<=)/],
    ["pph_risk", /postpartum haemorrhage|postpartum hemorrhage|\bpph\b|caesarean blood loss|cesarean blood loss|postpartum.*bleed/],
  ];

  for (const [key, pattern] of patterns) {
    if (pattern.test(text)) keys.add(key);
  }

  if (keys.has("pph_risk") && /postpartum|after delivery|after birth|\bpph\b/.test(text)) {
    keys.delete("pv_bleeding");
  }

  return keys;
}

function hasExplicitConditionSignal(text: string) {
  return /diabetic ketoacidosis|\bdka\b|burn|scald|head injur(?:y|ies)|head trauma|chest trauma|chest injury|abdominal injury|abdominal trauma|vaginal bleeding|pv bleeding|per vaginal|antepartum|postpartum haemorrhage|postpartum hemorrhage|\bpph\b|asthma|pneumonia|fast breathing|difficult breathing|difficulty breathing|chest indrawing|hyperkalaemia|hyperkalemia|hyponatraemia|hyponatremia|hypernatraemia|hypernatremia|epigastric|peptic|gastritis/.test(
    text,
  );
}

function extractFacts(text: string) {
  const lower = text.toLowerCase();
  const bp = lower.match(/\b(\d{2,3})\s*\/\s*(\d{2,3})\b/);

  return {
    text: lower,
    fever: booleanConcept(lower, /fever|hotness|pyrexia/, NO_FEVER),
    pregnant: booleanConcept(lower, PREGNANT, NOT_PREGNANT),
    gestationWeeks: weeks(lower),
    gestationWeeksMention: weeksMention(lower),
    shock: booleanConcept(lower, SHOCK, STABLE),
    activeBleeding: booleanConcept(lower, ACTIVE_BLEEDING, RESOLVED_BLEEDING),
    neurologicalSymptoms: booleanConcept(lower, NEURO, NO_NEURO),
    urinarySymptoms: booleanConcept(lower, /dysuria|urinary|flank pain|suprapubic|haematuria|hematuria|pyuria/, NO_URINARY),
    respiratorySymptoms: booleanConcept(
      lower,
      /fast breathing|difficult breathing|difficulty breathing|tachypnoea|chest indrawing|pneumonia|wheez\w*/,
      NO_RESPIRATORY,
    ),
    earPain: booleanConcept(lower, /ear pain|otitis|otorrhoea|mastoid/, NO_EAR_PAIN),
    dangerSigns: booleanConcept(
      lower,
      /danger sign|letharg|unconscious|cannot drink|unable to drink|convulsion|seizure/,
      /no danger sign|no letharg|able to drink|able to feed|no convulsion|no seizure/,
    ),
    malaria: /malaria.*positive|positive.*malaria/.test(lower)
      ? "positive"
      : /malaria.*negative|negative.*malaria/.test(lower)
        ? "negative"
        : undefined,
    cbc: /granulocytosis/.test(lower)
      ? "granulocytosis"
      : /lymphocytosis/.test(lower)
        ? "lymphocytosis"
        : /cbc.*normal|normal.*cbc|fbc.*normal|normal.*fbc|blood count.*normal|normal.*blood count|blodd count.*normal|normal.*blodd count/.test(lower)
          ? "normal"
          : undefined,
    haemoglobin: haemoglobinMention(lower)?.value ?? null,
    haemoglobinMention: haemoglobinMention(lower),
    gcs: gcs(lower),
    gcsMention: gcsMention(lower),
    ageYears: ageYears(lower),
    ageYearsMention: ageYearsMention(lower),
    ageMonths: ageMonths(lower),
    ageDays: ageDays(lower),
    ageDaysMention: ageDaysMention(lower),
    ageWeeks: ageWeeks(lower),
    ageWeeksMention: ageWeeksMention(lower),
    durationDays: durationDays(lower),
    durationDaysMention: durationDaysMention(lower),
    tbsa: tbsa(lower),
    tbsaMention: tbsaMention(lower),
    burnDepth: /full thickness|third degree/.test(lower)
      ? "full thickness"
      : /partial thickness|second degree/.test(lower)
        ? "partial thickness"
        : /superficial|first degree/.test(lower)
          ? "superficial"
          : undefined,
    specialAreaBurn: specialAreaBurnKnown(lower) ? specialAreaBurnPresent(lower) : undefined,
    potassium: potassium(lower),
    potassiumMention: potassiumMention(lower),
    potassiumStatus: potassiumStatus(lower),
    sodium: sodium(lower),
    sodiumMention: sodiumMention(lower),
    sodiumStatus: /sodium.*(?:high|raised|elevated|above normal)|(?:high|raised|elevated|above normal).*sodium|hypernatraemia|hypernatremia/.test(lower)
      ? "high"
      : /sodium.*(?:low|below normal)|(?:low|below normal).*sodium|hyponatraemia|hyponatremia/.test(lower)
        ? "low"
        : undefined,
    glucose: bloodGlucose(lower),
    glucoseMention: bloodGlucoseMention(lower),
    ph: ph(lower),
    phMention: phMention(lower),
    bicarbonate: bicarbonate(lower),
    bicarbonateMention: bicarbonateMention(lower),
    ketones: /ketone/.test(lower)
      ? /ketone.*(?:2\+|positive)|(?:2\+|positive).*ketone/.test(lower)
        ? "positive"
        : "mentioned"
      : undefined,
    bloodPressure: bp ? { systolic: Number(bp[1]), diastolic: Number(bp[2]) } : undefined,
    convulsions: booleanConcept(lower, /convulsion|seizure/, /no convulsion|no seizure|without convulsion|without seizure/),
    bloodLossMl: pphBloodLoss(lower),
    bloodLossMention: pphBloodLossMention(lower),
    targetOrganDamage: booleanConcept(lower, TARGET_ORGAN, NO_TARGET_ORGAN),
    hPylori: /h\.?\s*pylori.*positive|positive.*h\.?\s*pylori/.test(lower)
      ? "positive"
      : /h\.?\s*pylori.*negative|negative.*h\.?\s*pylori/.test(lower)
        ? "negative"
        : undefined,
    vomiting: booleanConcept(lower, /vomit\w*|emesis/, NO_VOMITING),
    bloodyVomitus: booleanConcept(lower, /bloody vomit\w*|haematemesis|hematemesis|vomit\w*.*blood/, NO_BLOODY_VOMITUS),
    percussionNote: /hyper-?resonant|hyperresonant/.test(lower)
      ? "hyper-resonant"
      : /dull percussion|dull note/.test(lower)
        ? "dull"
        : undefined,
    dehydration: /severe dehydration|plan c|letharg|drinking poorly|6%\s*or more|more than 6%|>=\s*6%/.test(lower)
      ? "severe"
      : /moderate dehydration|some dehydration|plan b|restless|irritable|sunken eyes|drinking eagerly|slow skin pinch|4-6%|4\s*to\s*6%/.test(lower)
        ? "some"
        : /no dehydration|plan a/.test(lower)
          ? "none"
          : undefined,
  };
}

type ExtractedFacts = ReturnType<typeof extractFacts>;

function criterionScore(criteria: Record<string, unknown>, facts: ExtractedFacts) {
  let score = 0;
  let contradictions = 0;

  const checkBoolean = (key: keyof ExtractedFacts, expected: unknown) => {
    if (typeof expected !== "boolean") return;
    const actual = facts[key];
    if (actual === undefined) return;
    if (actual === expected) score += 2;
    else contradictions += 1;
  };

  checkBoolean("pregnant", criteria.pregnant);
  checkBoolean("fever", criteria.fever);
  checkBoolean("shock", criteria.shock);
  checkBoolean("activeBleeding", criteria.active_bleeding);
  checkBoolean("neurologicalSymptoms", criteria.neurological_symptoms);
  checkBoolean("urinarySymptoms", criteria.urinary_symptoms);
  checkBoolean("respiratorySymptoms", criteria.respiratory_symptoms);
  checkBoolean("earPain", criteria.ear_pain);
  checkBoolean("dangerSigns", criteria.danger_signs);
  checkBoolean("targetOrganDamage", criteria.target_organ_damage);
  checkBoolean("convulsions", criteria.convulsions);

  if (criteria.gestation_weeks && facts.gestationWeeks !== null) {
    const rule = criteria.gestation_weeks as Record<string, unknown>;
    const matches = mentionMatchesRule(facts.gestationWeeksMention, rule);
    if (matches === true) score += 3;
    else if (matches === false) contradictions += 1;
    else if (typeof rule.lt === "number" && facts.gestationWeeks < rule.lt) score += 3;
    else if (typeof rule.gt === "number" && facts.gestationWeeks > rule.gt) score += 3;
    else contradictions += 1;
  }

  if (criteria.duration_days && facts.durationDays !== null) {
    const rule = criteria.duration_days as Record<string, unknown>;
    const matches = mentionMatchesRule(facts.durationDaysMention, rule);
    if (matches === true) score += 3;
    else if (matches === false) contradictions += 1;
    else if (typeof rule.lt === "number" && facts.durationDays < rule.lt) score += 3;
    else if (typeof rule.gt === "number" && facts.durationDays > rule.gt) score += 3;
    else contradictions += 1;
  }

  if (criteria.age_days && facts.ageDays !== null) {
    const rule = criteria.age_days as Record<string, unknown>;
    if (typeof rule.lt === "number" && facts.ageDays < rule.lt) score += 3;
    else if (typeof rule.gt === "number" && facts.ageDays > rule.gt) score += 3;
    else if (typeof rule.lte === "number" && facts.ageDays <= rule.lte) score += 3;
    else if (typeof rule.gte === "number" && facts.ageDays >= rule.gte) score += 3;
    else contradictions += 1;
  }

  if (criteria.gcs && facts.gcs !== null) {
    const rule = criteria.gcs as Record<string, unknown>;
    const matches = mentionMatchesRule(facts.gcsMention, rule);
    if (matches === true) score += 4;
    else if (matches === false) contradictions += 1;
    else {
      const gcsValue = facts.gcs;
      const aboveMin = typeof rule.gte !== "number" || gcsValue >= rule.gte;
      const belowMax = typeof rule.lte !== "number" || gcsValue <= rule.lte;
      const belowLt = typeof rule.lt !== "number" || gcsValue < rule.lt;
      if (aboveMin && belowMax && belowLt) score += 4;
      else contradictions += 1;
    }
  }

  if (criteria.malaria && facts.malaria) {
    if (criteria.malaria === facts.malaria) score += 3;
    else contradictions += 1;
  }

  if (criteria.cbc && facts.cbc) {
    if (Array.isArray(criteria.cbc)) {
      if (criteria.cbc.includes(facts.cbc)) score += 2;
      else contradictions += 1;
    } else if (criteria.cbc === facts.cbc) score += 2;
    else contradictions += 1;
  }

  if (criteria.haemoglobin_g_dl && facts.haemoglobin !== null) {
    const rule = criteria.haemoglobin_g_dl as Record<string, unknown>;
    const matches = mentionMatchesRule(facts.haemoglobinMention, rule);
    if (matches === true) score += 3;
    else if (matches === false) contradictions += 1;
    else if (typeof rule.lt === "number" && facts.haemoglobin < rule.lt) score += 3;
    else if (typeof rule.gt === "number" && facts.haemoglobin > rule.gt) score += 3;
    else contradictions += 1;
  }

  if (criteria.h_pylori && facts.hPylori) {
    score += criteria.h_pylori === facts.hPylori ? 3 : -2;
  }

  if (criteria.blood_pressure && facts.bloodPressure) {
    const rule = criteria.blood_pressure as Record<string, unknown>;
    if (typeof rule.gte === "string") {
      const meets = bloodPressureMeets(facts.bloodPressure, rule.gte);
      if (meets === true) score += 3;
      else if (meets === false) contradictions += 1;
    }
  }

  if (criteria.severe_hypertension !== undefined) {
    const severe = hasSevereHypertension(facts);
    if (severe !== null) score += severe === criteria.severe_hypertension ? 3 : -2;
  }

  if (criteria.mild_hypertension !== undefined) {
    const mild = hasMildHypertension(facts);
    if (mild !== null) score += mild === criteria.mild_hypertension ? 3 : -2;
  }

  if (criteria.bloody_vomitus !== undefined && facts.bloodyVomitus !== undefined) {
    score += criteria.bloody_vomitus === facts.bloodyVomitus ? 2 : -2;
  }

  if (criteria.vomiting !== undefined && facts.vomiting !== undefined) {
    score += criteria.vomiting === facts.vomiting ? 1 : -1;
  }

  if (criteria.percussion_note && facts.percussionNote) {
    score += criteria.percussion_note === facts.percussionNote ? 3 : -2;
  }

  if (criteria.serum_sodium_mmol_l && (facts.sodium !== null || facts.sodiumStatus)) {
    const rule = criteria.serum_sodium_mmol_l as Record<string, unknown>;
    const matches = mentionMatchesRule(facts.sodiumMention, rule);
    if (matches === true) score += 3;
    else if (matches === false) contradictions += 1;
    else if (typeof rule.gt === "number" && facts.sodiumStatus === "high") score += 2;
    else if (typeof rule.lt === "number" && facts.sodiumStatus === "low") score += 2;
    else if (facts.sodium !== null && typeof rule.gt === "number" && facts.sodium > rule.gt) score += 3;
    else if (facts.sodium !== null && typeof rule.lt === "number" && facts.sodium < rule.lt) score += 3;
    else contradictions += 1;
  }

  if (criteria.serum_potassium === "above_normal" && (facts.potassium !== null || facts.potassiumStatus)) {
    if (
      facts.potassiumStatus === "above_normal" ||
      facts.potassiumMention?.comparator === "gt" ||
      facts.potassiumMention?.comparator === "gte" ||
      (facts.potassium !== null && facts.potassium > 5)
    )
      score += 3;
    else contradictions += 1;
  }

  if (criteria.dehydration && facts.dehydration) {
    score += criteria.dehydration === facts.dehydration ? 3 : -2;
  }

  if (criteria.complicated_signs && Array.isArray(criteria.complicated_signs)) {
    const signText = criteria.complicated_signs.map(String).join(" | ").toLowerCase();
    const matchedSigns = [
      /flank pain/.test(facts.text) && /flank pain/.test(signText),
      /suprapubic/.test(facts.text) && /suprapubic/.test(signText),
      /haematuria|hematuria/.test(facts.text) && /haematuria/.test(signText),
      /vomit/.test(facts.text) && /vomiting/.test(signText),
      /pyuria/.test(facts.text) && /pyuria/.test(signText),
    ].filter(Boolean).length;
    if (matchedSigns) score += Math.min(matchedSigns, 3);
  }

  if (criteria.pph_definition && Array.isArray(criteria.pph_definition)) {
    const definitionText = criteria.pph_definition.map(String).join(" | ").toLowerCase();
    if (/postpartum|after delivery|after birth|\bpph\b/.test(facts.text)) score += 2;
    if (facts.bloodLossMl !== null) {
      const above500 = facts.bloodLossMl > 500 || (facts.bloodLossMl === 500 && facts.bloodLossMention?.comparator === "gt");
      const above1000 = facts.bloodLossMl > 1000 || (facts.bloodLossMl === 1000 && facts.bloodLossMention?.comparator === "gt");
      if (/vaginal bleeding >500/.test(definitionText) && above500) score += 4;
      if (/caesarean blood loss >1000/.test(definitionText) && above1000) score += 4;
    }
  }

  if (criteria.high_risk_factors && Array.isArray(criteria.high_risk_factors)) {
    const riskText = criteria.high_risk_factors.map(String).join(" | ").toLowerCase();
    const matchedRisks = [
      /placenta/.test(facts.text) && /placenta/.test(riskText),
      /coagulopathy/.test(facts.text) && /coagulopathy/.test(riskText),
      /active bleeding/.test(facts.text) && /active bleeding/.test(riskText),
      /chorioamnionitis/.test(facts.text) && /chorioamnionitis/.test(riskText),
      /oxytocin/.test(facts.text) && /oxytocin/.test(riskText),
      /platelet/.test(facts.text) && /platelet/.test(riskText),
    ].filter(Boolean).length;
    if (matchedRisks) score += Math.min(matchedRisks, 3);
  }

  if (criteria.criteria_any && Array.isArray(criteria.criteria_any)) {
    const textCriteria = criteria.criteria_any.map(String).join(" | ").toLowerCase();
    const tbsaGt10 = facts.tbsa !== null && (facts.tbsa > 10 || (facts.tbsa === 10 && facts.tbsaMention?.comparator === "gt"));
    const tbsaGt20 = facts.tbsa !== null && (facts.tbsa > 20 || (facts.tbsa === 20 && facts.tbsaMention?.comparator === "gt"));
    const tbsaGt25 = facts.tbsa !== null && (facts.tbsa > 25 || (facts.tbsa === 25 && facts.tbsaMention?.comparator === "gt"));
    const tbsaLt2 = facts.tbsa !== null && (facts.tbsa < 2 || (facts.tbsa === 2 && facts.tbsaMention?.comparator === "lt"));
    const tbsaLt10 = facts.tbsa !== null && (facts.tbsa < 10 || (facts.tbsa === 10 && facts.tbsaMention?.comparator === "lt"));
    const tbsaLt15 = facts.tbsa !== null && (facts.tbsa < 15 || (facts.tbsa === 15 && facts.tbsaMention?.comparator === "lt"));
    if (facts.burnDepth === "full thickness" && facts.tbsa !== null) {
      if (/full thickness >10/.test(textCriteria) && tbsaGt10) score += 4;
      if (/full thickness 2-10/.test(textCriteria) && facts.tbsa >= 2 && facts.tbsa <= 10) score += 4;
      if (/full thickness <2/.test(textCriteria) && tbsaLt2) score += 4;
    }
    if (facts.burnDepth === "partial thickness" && facts.tbsa !== null) {
      if (/15-25%/.test(textCriteria) && facts.tbsa >= 15 && facts.tbsa <= 25) score += 4;
      if (/>25%/.test(textCriteria) && tbsaGt25) score += 4;
      if (/>20%/.test(textCriteria) && tbsaGt20) score += 4;
      if (/<15%/.test(textCriteria) && tbsaLt15) score += 4;
      if (/<10%/.test(textCriteria) && tbsaLt10) score += 4;
    }
    if (facts.specialAreaBurn === true && /face hands feet genitalia perineum|major joints/.test(textCriteria)) score += 4;
  }

  if (criteria.features && Array.isArray(criteria.features)) {
    const featureText = criteria.features.map(String).join(" | ").toLowerCase();
    const matchedFeatures = [
      /polyuria/.test(facts.text) && /polyuria/.test(featureText),
      /polydipsia/.test(facts.text) && /polydipsia/.test(featureText),
      /weight loss/.test(facts.text) && /weight loss/.test(featureText),
      /abdominal pain/.test(facts.text) && /abdominal pain/.test(featureText),
      /tiredness|fatigue/.test(facts.text) && /tiredness/.test(featureText),
      /vomit/.test(facts.text) && /vomiting/.test(featureText),
      /dehydrat/.test(facts.text) && /dehydration/.test(featureText),
      /kussmaul/.test(facts.text) && /kussmaul/.test(featureText),
      /ketone/.test(facts.text) && /ketone/.test(featureText),
      facts.ketones !== undefined && /ketone/.test(featureText),
      facts.glucose !== null && /blood sugar/.test(featureText),
      facts.ph !== null && /\bpH <7\.3/i.test(featureText),
      facts.bicarbonate !== null && /bicarbonate/.test(featureText),
    ].filter(Boolean).length;

    score += Math.min(matchedFeatures, 5);
  }

  return { score, contradictions };
}

function requiredFactKnown(fact: string, facts: ExtractedFacts) {
  const map: Record<string, boolean> = {
    pregnancy_status: facts.pregnant !== undefined,
    shock_status: facts.shock !== undefined,
    gestation_weeks: facts.gestationWeeks !== null,
    duration_days: facts.durationDays !== null,
    active_bleeding: facts.activeBleeding !== undefined,
    age_years: facts.ageYears !== null,
    age_months: facts.ageMonths !== null,
    age_days: facts.ageDays !== null,
    gcs: facts.gcs !== null,
    blood_pressure: Boolean(facts.bloodPressure),
    target_organ_damage: facts.targetOrganDamage !== undefined,
    malaria_result: Boolean(facts.malaria),
    cbc_result: Boolean(facts.cbc),
    haemoglobin: facts.haemoglobin !== null,
    severity_features: /severe|thrombocytopenia|anaemia|anemia/.test(facts.text),
    burn_depth: Boolean(facts.burnDepth),
    tbsa_percent: facts.tbsa !== null,
    special_area_burn: facts.specialAreaBurn !== undefined,
    h_pylori_result: Boolean(facts.hPylori),
    serum_potassium: facts.potassium !== null || facts.potassiumStatus === "above_normal",
    serum_sodium: facts.sodium !== null || Boolean(facts.sodiumStatus),
    blood_glucose: facts.glucose !== null,
    ketones: facts.ketones !== undefined,
    ph: facts.ph !== null,
    bicarbonate: facts.bicarbonate !== null,
    dehydration_status: Boolean(facts.dehydration),
    percussion_note: Boolean(facts.percussionNote),
    respiratory_classification: /very severe pneumonia|severe pneumonia|non-?severe pneumonia|no pneumonia|chest indrawing|tachypnoea|fast breathing|difficulty breathing/.test(
      facts.text,
    ),
    complicated_otitis_signs: /otorrhoea|mastoid|cranial nerve|complicated/.test(facts.text),
    complicated_uti_signs: /flank pain|suprapubic|haematuria|hematuria|vomit|pyuria|complicated/.test(facts.text),
    associated_features: /convulsion|confusion|csf|penetrating|fracture|deformity|blurred vision|vomit|anisocoria|lateralising|lateralizing|under 5|over 60/.test(
      facts.text,
    ),
    injury_type: /injury|trauma|penetrating|blunt/.test(facts.text),
    convulsions: facts.convulsions !== undefined,
    respiratory_failure_features: /drows|confus|paradoxical thoracoabdominal|absence of wheeze|silent chest|bradycardia/.test(
      facts.text,
    ),
    asthma_severity_features: /wheeze|pulsus|accessory muscle|sitting upright|agitation|end expiration|respiratory/.test(
      facts.text,
    ),
    burn_mechanism: /electrical|chemical|inhalation|circumferential/.test(facts.text),
    comorbidity: /comorbid|pre-existing|medical disorder/.test(facts.text),
    neurological_status: /seizure|coma|conscious|letharg|headache|neurolog/.test(facts.text),
    volume_status: /hypovolaemic|hypovolemic|euvolemic|hypervolemic|jvp|oedema|edema|volume status/.test(facts.text),
    weight_kg: /\b\d+(?:\.\d+)?\s*kg\b|kilogram/.test(facts.text),
    obstetric_risk_factors: /placenta|caesarean|cesarean|myomectomy|multiple gestation|platelet|coagulopathy|chorioamnionitis|oxytocin|second stage|myoma|bmi|haematocrit/.test(
      facts.text,
    ),
    estimated_blood_loss: /\b\d{3,4}\s*(?:ml|millilit)/.test(facts.text),
  };

  return map[fact] || false;
}

function criteriaFactMissing(criteria: Record<string, unknown>, facts: ExtractedFacts) {
  const missing: string[] = [];

  if (criteria.gestation_weeks && facts.gestationWeeks === null) missing.push("gestation_weeks");
  if (criteria.duration_days && facts.durationDays === null) missing.push("duration_days");
  if (criteria.age_days && facts.ageDays === null) missing.push("age_days");
  if (criteria.convulsions !== undefined && facts.convulsions === undefined) missing.push("convulsions");
  if (criteria.gcs && facts.gcs === null) missing.push("gcs");
  if (criteria.malaria && !facts.malaria) missing.push("malaria_result");
  if (criteria.cbc && !facts.cbc) missing.push("cbc_result");
  if (criteria.haemoglobin_g_dl && facts.haemoglobin === null) missing.push("haemoglobin");
  if (criteria.h_pylori && !facts.hPylori) missing.push("h_pylori_result");
  if (criteria.serum_sodium_mmol_l && facts.sodium === null && !facts.sodiumStatus) missing.push("serum_sodium");
  if (criteria.serum_potassium && facts.potassium === null && !facts.potassiumStatus) missing.push("serum_potassium");
  if (criteria.blood_pressure && !facts.bloodPressure) missing.push("blood_pressure");
  if (criteria.severe_hypertension !== undefined && !facts.bloodPressure) missing.push("blood_pressure");
  if (criteria.mild_hypertension !== undefined && !facts.bloodPressure) missing.push("blood_pressure");
  if (criteria.target_organ_damage !== undefined && facts.targetOrganDamage === undefined) {
    missing.push("target_organ_damage");
  }
  if (criteria.percussion_note && !facts.percussionNote) missing.push("percussion_note");
  if (criteria.dehydration && !facts.dehydration) missing.push("dehydration_status");

  return missing;
}

function formatTableNode(node: PathwayNode, documents: Document[]) {
  const result: GuardResult = {
    condition: node.conditionName,
    branch: node.title,
    severity: node.severity === "emergency" ? "critical" : node.severity,
    disposition: node.disposition,
    summary: node.summary,
    sourceSection: node.sourceSection,
  };
  const details: PathwayDetails = {
    title: node.title,
    summary: node.summary,
    managementText: node.managementText,
    sourceSection: node.sourceSection,
    investigations: node.investigations,
  };

  return formatGuard(result, documents, details);
}

function tableNodeToGuard(node: PathwayNode) {
  return {
    condition: node.conditionName,
    branch: node.title,
    severity: node.severity === "emergency" ? "critical" : node.severity,
    disposition: node.disposition,
    summary: node.summary,
    sourceSection: node.sourceSection,
  } satisfies GuardResult;
}

function tableNodeToDetails(node: PathwayNode): PathwayDetails {
  return {
    title: node.title,
    summary: node.summary,
    managementText: node.managementText,
    sourceSection: node.sourceSection,
    investigations: node.investigations,
  };
}

function formatTableFollowUp(
  conditionName: string,
  missingFacts: string[],
  documents: Document[],
  _details?: PathwayDetails | null,
  fallbackSection = "not indexed",
) {
  const questions = missingFacts.slice(0, 5).map((fact) => `- ${missingFactQuestion(fact)}`).join("\n");

  return `I can help classify this using the internal clinical guideline, but I need a few details before deciding the exact pathway.

For ${conditionName.toLowerCase()}, please confirm:
${questions}

Once you answer, I will match the correct pathway and include recommended tests, medications, and management.

Source:
${internalSource(documents, fallbackSection)}`;
}

async function buildTableDrivenAnswer(question: string, documents: Document[], currentQuestion = question) {
  const text = normalizeClinicalText(question);
  const currentText = normalizeClinicalText(currentQuestion);
  const currentConditionKeys = detectConditionKeys(currentText);
  const wantsFollowUp = asksForDiagnostics(currentText) || asksForTreatment(currentText);
  const useCurrentScope = currentConditionKeys.size > 0 && hasExplicitConditionSignal(currentText) && !wantsFollowUp;
  const conditionKeys = useCurrentScope
    ? currentConditionKeys.size
      ? currentConditionKeys
      : detectConditionKeys(text)
    : detectConditionKeys(text);
  if (!conditionKeys.size) return null;

  const facts = extractFacts(useCurrentScope ? currentText : text);
  const nodes = (await listPathwayNodes()).filter((node) => conditionKeys.has(node.conditionKey));
  if (!nodes.length) return null;

  const pneumoniaNode = nodes.find((node) => node.nodeKey === "fever_pneumonia_child_over_60_days");
  if (pneumoniaNode && pneumoniaClassification(text)) {
    const result = tableNodeToGuard(pneumoniaNode);
    const details = tableNodeToDetails(pneumoniaNode);
    const wantsDiagnostics = asksForDiagnostics(currentQuestion.toLowerCase());
    const wantsTreatment = asksForTreatment(currentQuestion.toLowerCase());
    const wantsCompleteness = asksForCompleteness(currentQuestion.toLowerCase());

    if (facts.ageDays === null) {
      return formatTableFollowUp(pneumoniaNode.conditionName, ["age_days"], documents, details, pneumoniaNode.sourceSection);
    }

    if (wantsDiagnostics && wantsTreatment) {
      return formatDiagnosticAndManagementFollowUp(result, documents, details);
    }

    if (wantsDiagnostics) {
      return formatDiagnosticFollowUp(result, documents, details);
    }

    if (wantsTreatment) {
      const managementAnswer = formatPneumoniaManagementFollowUp(result, documents, facts);
      if (managementAnswer) return managementAnswer;
    }

    if (wantsCompleteness) {
      return formatPneumoniaCompletenessFollowUp(result, documents, facts, details);
    }

    return formatPneumoniaGuard(result, documents, facts, details);
  }

  const moderateBurnNode = nodes.find((node) => node.nodeKey === "burn_moderate");
  if (moderateBurnNode && facts.specialAreaBurn === true) {
    const result = tableNodeToGuard(moderateBurnNode);
    const details = tableNodeToDetails(moderateBurnNode);
    const wantsDiagnostics = asksForDiagnostics(currentQuestion.toLowerCase());
    const wantsTreatment = asksForTreatment(currentQuestion.toLowerCase());

    if (wantsDiagnostics && wantsTreatment) {
      return formatDiagnosticAndManagementFollowUp(result, documents, details);
    }

    if (wantsDiagnostics) {
      return formatDiagnosticFollowUp(result, documents, details);
    }

    if (wantsTreatment) {
      const managementAnswer = formatManagementFollowUp(result, documents, details);
      if (managementAnswer) return managementAnswer;
    }

    return formatTableNode(moderateBurnNode, documents);
  }

  const ranked = nodes
    .map((node) => {
      const scored = criterionScore(node.criteria, facts);
      const knownRequired = node.requiredFacts.filter((fact) => requiredFactKnown(fact, facts)).length;
      const missingCriteriaFacts = criteriaFactMissing(node.criteria, facts);
      return {
        node,
        score: scored.score + knownRequired,
        contradictions: scored.contradictions,
        missingCriteriaFacts,
      };
    })
    .filter((item) => item.contradictions === 0)
    .sort((a, b) => b.score - a.score);

  const best = ranked.find((item) => item.missingCriteriaFacts.length === 0);
  if (best && best.score >= 3) {
    const result = tableNodeToGuard(best.node);
    const details = tableNodeToDetails(best.node);
    const wantsDiagnostics = asksForDiagnostics(currentQuestion.toLowerCase());
    const wantsTreatment = asksForTreatment(currentQuestion.toLowerCase());
    const wantsInsulin = asksForInsulin(currentQuestion.toLowerCase());
    const wantsCompleteness = asksForCompleteness(currentQuestion.toLowerCase());

    if (wantsInsulin) {
      const focusedAnswer = formatFocusedManagementFollowUp(result, documents, details, "insulin");
      if (focusedAnswer) return focusedAnswer;
    }

    if (wantsDiagnostics && wantsTreatment) {
      return formatDiagnosticAndManagementFollowUp(result, documents, details);
    }

    if (wantsDiagnostics) {
      return formatDiagnosticFollowUp(result, documents, details);
    }

    if (best.node.nodeKey === "fever_pneumonia_child_over_60_days" && wantsTreatment) {
      const managementAnswer = formatPneumoniaManagementFollowUp(result, documents, facts);
      if (managementAnswer) return managementAnswer;
    }

    if (wantsTreatment) {
      const managementAnswer = formatManagementFollowUp(result, documents, details);
      if (managementAnswer) return managementAnswer;
    }

    if (best.node.nodeKey === "fever_pneumonia_child_over_60_days") {
      if (wantsCompleteness) {
        return formatPneumoniaCompletenessFollowUp(result, documents, facts, details);
      }
      return formatPneumoniaGuard(result, documents, facts, details);
    }

    return formatTableNode(best.node, documents);
  }

  const missing = Array.from(
    new Set(
      (ranked.length ? ranked.flatMap((item) => item.missingCriteriaFacts) : nodes.flatMap((node) => node.requiredFacts))
        .filter((fact) => !requiredFactKnown(fact, facts)),
    ),
  );

  if (missing.length) {
    const partial = ranked[0];
    if (partial?.score >= 2) {
      return formatTableFollowUp(
        partial.node.conditionName,
        missing,
        documents,
        tableNodeToDetails(partial.node),
        partial.node.sourceSection,
      );
    }

    return formatTableFollowUp(nodes[0].conditionName, missing, documents);
  }
  return null;
}

function internalSource(documents: Document[], fallbackSection: string) {
  const metadata = (documents[0]?.metadata || {}) as Record<string, unknown>;
  const metadataSection = String(metadata.sectionNumber || "");
  const section =
    fallbackSection && fallbackSection !== "not indexed"
      ? fallbackSection
      : metadataSection && metadataSection !== "not indexed"
        ? metadataSection
        : fallbackSection;
  const line =
    typeof metadata.lineNumber === "number"
      ? metadata.lineNumber
      : typeof metadata.startLine === "number"
        ? metadata.startLine
        : typeof metadata.chunkIndex === "number"
          ? metadata.chunkIndex + 1
          : "not indexed";
  const score = typeof metadata.score === "number" ? metadata.score.toFixed(3) : "not available";

  return `Internal clinical guideline, section ${section}, line/chunk ${line}, score ${score}`;
}

function missingFactQuestion(fact: string) {
  const questions: Record<string, string> = {
    age_years: "How old is the patient?",
    gestation_weeks: "How many weeks pregnant is the patient?",
    burn_depth: "What is the burn depth: superficial, partial thickness, or full thickness?",
    tbsa_percent: "About what percent of total body surface area is burned?",
    special_area_burn: "Is the burn on the face, hands, feet, genitalia, perineum, or over major joints?",
    age_days: "How many days old is the child?",
    "danger signs": "Are there any danger signs such as lethargy, convulsions, inability to drink/feed, or reduced consciousness?",
    "chest indrawing": "Is there chest indrawing?",
    tachypnoea: "Is the breathing rate fast for age?",
    "ability to feed": "Can the child drink or feed?",
    age_months: "How many months old is the child?",
    "complicated otitis signs": "Are there complicated ear signs such as mastoid swelling, severe pain, or discharge?",
    "H. pylori result if not already known": "Is the H. pylori test positive, negative, or not yet done?",
  };

  return questions[fact] || `Can you confirm ${fact.replace(/_/g, " ")}?`;
}

function formatFollowUp(result: GuardResult, documents: Document[]) {
  const questions = (result.missing || []).map((fact) => `- ${missingFactQuestion(fact)}`).join("\n");

  return `I can help classify this using the internal clinical guideline, but I need a few details before deciding severity or disposition.

For ${result.condition.toLowerCase()}, please confirm:
${questions}

Once you answer those, I will match the correct pathway from the internal clinical guideline.

Source:
${internalSource(documents, result.sourceSection)}`;
}

function formatInvestigationList(details?: PathwayDetails | null) {
  if (!details?.investigations.length) return "";
  return `\n\nRecommended diagnostic tests:\n${details.investigations.map((item) => `- ${item}`).join("\n")}`;
}

function formatManagementText(result: GuardResult, details?: PathwayDetails | null) {
  const text = details?.managementText || result.management;
  if (!text) return "";
  return `\n\nManagement and medication guidance:\n${text}`;
}

function pneumoniaClassification(text: string) {
  if (/very severe pneumonia|unable to drink|unable to feed|cannot drink|cannot feed|letharg|unconscious|convulsion|seizure|central cyanosis|stridor/.test(text)) {
    return {
      label: "Very severe pneumonia",
      disposition: "admit",
      management: "Admit for oxygen and IV amoxicillin/clavulanate 40 mg/kg/day plus IV paracetamol.",
    };
  }

  if (/sever\w*\s+pneumonia|chest indrawing/.test(text)) {
    return {
      label: "Severe pneumonia",
      disposition: "admit",
      management: "Admit for IV amoxicillin/clavulanate 40 mg/kg/day and IV paracetamol.",
    };
  }

  if (/non-?severe pneumonia|fast breathing|tachypnoea|tachypnea/.test(text)) {
    return {
      label: "Non-severe pneumonia",
      disposition: "outpatient",
      management: "Give outpatient oral amoxicillin/clavulanate 40 mg/kg/day plus paracetamol, and follow up in 2 days.",
    };
  }

  if (/no pneumonia/.test(text)) {
    return {
      label: "No pneumonia",
      disposition: "outpatient",
      management: "No antibiotics; outpatient symptomatic treatment and follow-up in 5 days.",
    };
  }

  return null;
}

function formatPneumoniaGuard(result: GuardResult, documents: Document[], facts: ExtractedFacts, details?: PathwayDetails | null) {
  const classification = pneumoniaClassification(facts.text);
  const disposition = classification?.disposition || result.disposition;
  const management = classification?.management || details?.managementText || result.management;
  const diagnosis = classification?.label || "Pneumonia requiring WHO severity classification";
  const checks = [
    facts.ageDays === null ? "Confirm the exact age in days/weeks/months." : "",
    "Check ability to drink or feed.",
    "Check for chest indrawing and count respiratory rate for age.",
    "Check oxygen saturation and work of breathing.",
    "Check danger signs: lethargy, unconsciousness, convulsions/seizure, inability to drink/feed, or central cyanosis.",
  ].filter(Boolean);

  return `Urgency: Urgent. This remains in the child pneumonia / difficult breathing pathway in the internal clinical guideline.

What this means:
${classification ? `The current facts fit ${diagnosis.toLowerCase()}.` : details?.summary || result.summary}

Recommended disposition:
${disposition}

Management and medication guidance:
${management || "No specific medication or management text is listed in the indexed pathway table."}

Would you check the following?
${checks.map((item) => `- ${item}`).join("\n")}

Possible diagnosis based on clinical guidelines:
- ${diagnosis}.

Source:
${internalSource(documents, result.sourceSection)}`;
}

function formatPneumoniaManagementFollowUp(result: GuardResult, documents: Document[], facts: ExtractedFacts) {
  const classification = pneumoniaClassification(facts.text);
  if (!classification) return null;

  return `For this current ${classification.label.toLowerCase()} case, the internal clinical guideline recommends:

- ${classification.management}

Recommended disposition:
${classification.disposition}

Source:
${internalSource(documents, result.sourceSection)}`;
}

function formatPneumoniaCompletenessFollowUp(
  result: GuardResult,
  documents: Document[],
  facts: ExtractedFacts,
  details?: PathwayDetails | null,
) {
  const classification = pneumoniaClassification(facts.text);
  const management = classification?.management || details?.managementText || result.management;
  const disposition = classification?.disposition || result.disposition;
  const investigations = details?.investigations.length
    ? details.investigations.map((item) => `- ${item}`).join("\n")
    : "- No specific diagnostic tests are listed in the indexed pathway table for this matched pneumonia pathway.";

  return `For the current matched pathway, this is what I can support from the internal clinical guideline:

Management:
- ${management || "No specific medication or management text is listed in the indexed pathway table."}

Recommended disposition:
${disposition}

Recommended diagnostic tests:
${investigations}

Still worth checking:
- Ability to drink or feed.
- Chest indrawing and respiratory rate for age.
- Oxygen saturation and work of breathing.
- Danger signs such as lethargy, unconsciousness, convulsions/seizure, inability to drink/feed, or central cyanosis.

Source:
${internalSource(documents, result.sourceSection)}`;
}

function formatGuard(result: GuardResult, documents: Document[], details?: PathwayDetails | null) {
  if (result.missing?.length) {
    return formatFollowUp(result, documents);
  }

  const opening =
    result.severity === "critical"
      ? `Urgency: Based on the details provided, this matches the ${result.branch.toLowerCase()} pathway for ${result.condition.toLowerCase()} in the internal clinical guideline.`
      : `Based on the details provided, this matches the ${result.branch.toLowerCase()} pathway for ${result.condition.toLowerCase()} in the internal clinical guideline.`;
  const investigations = formatInvestigationList(details);
  const management = formatManagementText(result, details);

  return `${opening}

What this means:
${details?.summary || result.summary}

Recommended disposition:
${result.disposition}
${investigations}
${management}

Source:
${internalSource(documents, result.sourceSection)}`;
}

function burnManagement(branch: string) {
  if (branch === "Mild burn injury") {
    return [
      "Outpatient oral flucloxacillin 50 mg/kg per dose.",
      "Paracetamol 10 mg/kg per dose for pain.",
      "Topical silver sulfadiazine.",
      "Cleanse with 0.25% chlorhexidine and apply clean wraps.",
      "Follow up in 3 days.",
    ];
  }

  if (branch === "Moderate burn injury") {
    return [
      "Admit for surgical review.",
      "Give IV flucloxacillin 50 mg/kg per dose.",
      "Give IV metronidazole 7.5 mg/kg.",
      "Give IM pethidine 50 mg for pain.",
      "Apply topical silver sulfadiazine.",
      "For facial burns, add tetracycline eye ointment.",
      "Give omeprazole 4 mg/kg per dose for GI protection.",
      "Follow fluid management protocols.",
    ];
  }

  if (branch === "Severe burn injury") {
    return [
      "Arrange specialised unit or intensive care management.",
      "Start aggressive fluid resuscitation.",
      "Give IV flucloxacillin and IV metronidazole.",
      "Provide blood product support if needed.",
      "Monitor coagulation profile and liver function tests.",
      "Arrange surgical review.",
    ];
  }

  return [];
}

function managementFor(result: GuardResult, details?: PathwayDetails | null) {
  if (details?.managementText) return [details.managementText];
  if (result.management) return [result.management];
  if (result.condition === "Burns") return burnManagement(result.branch);
  return [];
}

function formatManagementFollowUp(result: GuardResult, documents: Document[], details?: PathwayDetails | null) {
  const management = managementFor(result, details);
  if (!management.length) return null;

  return `For this ${result.branch.toLowerCase()} pathway, the internal clinical guideline recommends:

${management.map((item) => `- ${item}`).join("\n")}

Recommended disposition:
${result.disposition}

Source:
${internalSource(documents, result.sourceSection)}`;
}

function formatFocusedManagementFollowUp(
  result: GuardResult,
  documents: Document[],
  details: PathwayDetails | null | undefined,
  focus: "insulin",
) {
  const managementText = managementFor(result, details).join(" ");
  if (!managementText) return null;

  const focusPattern = /insulin|glucose|dextrose|subcutaneous/i;
  const sentences = managementText
    .split(/(?<=\.)\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => focusPattern.test(sentence));

  if (!sentences.length) return null;

  return `For this ${result.branch.toLowerCase()} pathway, the internal clinical guideline gives this ${focus} guidance:

${sentences.map((item) => `- ${item}`).join("\n")}

Recommended disposition:
${result.disposition}

Source:
${internalSource(documents, result.sourceSection)}`;
}

function formatDiagnosticFollowUp(result: GuardResult, documents: Document[], details?: PathwayDetails | null) {
  if (!details?.investigations.length) {
    return `The matched ${result.branch.toLowerCase()} pathway does not list specific diagnostic tests in the indexed pathway table.

Source:
${internalSource(documents, result.sourceSection)}`;
  }

  return `For this ${result.branch.toLowerCase()} pathway, the internal clinical guideline lists these diagnostic tests:

${details.investigations.map((item) => `- ${item}`).join("\n")}

Source:
${internalSource(documents, result.sourceSection)}`;
}

function formatDiagnosticAndManagementFollowUp(result: GuardResult, documents: Document[], details?: PathwayDetails | null) {
  const investigations = details?.investigations.length
    ? details.investigations.map((item) => `- ${item}`).join("\n")
    : "- No specific diagnostic tests are listed in the indexed pathway table.";
  const management = managementFor(result, details);

  return `For this ${result.branch.toLowerCase()} pathway, the internal clinical guideline lists:

Recommended diagnostic tests:
${investigations}

Management and medication guidance:
${management.length ? management.map((item) => `- ${item}`).join("\n") : "- No specific medication or management text is listed in the indexed pathway table."}

Recommended disposition:
${result.disposition}

Source:
${internalSource(documents, result.sourceSection)}`;
}

const RULES: GuardRule[] = [
  {
    conditionPattern: PV_BLEEDING,
    match: (t) => has(t, PREGNANT) && gestationUnder20Weeks(t) && has(t, SHOCK),
    condition: "Per Vaginal Bleeding",
    branch: "Pregnant patient less than 20 weeks with signs of shock",
    severity: "critical",
    disposition: "admit",
    summary: "Abortion complicated by haemodynamic instability.",
    management: "Immediate ABC resuscitation, obstetric ultrasound, assess infection/coagulopathy/anaemia, admit for gynaecological review.",
    sourceSection: "1.2",
  },
  {
    conditionPattern: PV_BLEEDING,
    match: (t) => has(t, PREGNANT) && gestationOver20Weeks(t) && has(t, SHOCK),
    condition: "Per Vaginal Bleeding",
    branch: "Pregnant patient more than 20 weeks with signs of shock",
    severity: "critical",
    disposition: "admit",
    summary: "Antepartum haemorrhage until proven otherwise.",
    management: "Prioritise maternal stabilisation, urgent obstetric assessment and ultrasound; admit for gynaecological review.",
    sourceSection: "1.3",
  },
  {
    conditionPattern: PV_BLEEDING,
    match: (t) => has(t, PREGNANT) && weeks(t) === null && has(t, SHOCK),
    condition: "Per Vaginal Bleeding",
    branch: "Pregnant patient with bleeding and signs of shock",
    severity: "critical",
    disposition: "admit",
    summary: "Pregnant patient with bleeding and shock features; gestational age is needed to select the exact pathway.",
    missing: ["gestation_weeks"],
    sourceSection: "1",
  },
  {
    conditionPattern: /vaginal bleeding|pv bleeding|per vaginal|uterine bleeding/,
    match: (t) => !has(t, PREGNANT) && has(t, SHOCK),
    condition: "Per Vaginal Bleeding",
    branch: "Non-pregnant patient with signs of shock",
    severity: "critical",
    disposition: "admit",
    summary: "Abnormal uterine bleeding complicated by hypovolaemic shock.",
    management: "ABC stabilisation, IV access, fluids, CBC/cross-match, pelvic ultrasound, gynaecological review.",
    sourceSection: "1.1",
  },
  {
    conditionPattern: /vaginal bleeding|pv bleeding|per vaginal|uterine bleeding/,
    match: (t) => !has(t, SHOCK) && has(t, ACTIVE_BLEEDING),
    condition: "Per Vaginal Bleeding",
    branch: "Haemodynamically stable with active bleeding",
    severity: "urgent",
    disposition: "admit",
    summary: "Stable patient with ongoing PV bleeding.",
    sourceSection: "1.4",
  },
  {
    conditionPattern: /vaginal bleeding|pv bleeding|per vaginal|uterine bleeding/,
    match: (t) => !has(t, SHOCK) && has(t, RESOLVED_BLEEDING),
    condition: "Per Vaginal Bleeding",
    branch: "Haemodynamically stable with resolved bleeding",
    severity: "routine",
    disposition: "outpatient",
    summary: "Stable patient after bleeding has resolved.",
    sourceSection: "1.4",
  },

  {
    conditionPattern: /fever|hotness|pyrexia|malaria/,
    match: (t) => has(t, NEURO),
    condition: "Hotness of Body (Acute Fever Syndromes)",
    branch: "Fever with neurological symptoms",
    severity: "critical",
    disposition: "admit",
    summary: "Possible CNS infection, metabolic derangement, or severe malaria.",
    sourceSection: "2.2",
  },
  {
    conditionPattern: /fever|hotness|pyrexia/,
    match: (t) => (ageDays(t) ?? 999) < 60 && /convulsion|seizure/.test(t),
    condition: "Hotness of Body (Acute Fever Syndromes)",
    branch: "Fever with convulsions in child under 60 days",
    severity: "critical",
    disposition: "admit",
    summary: "Possible neonatal sepsis or meningitis.",
    sourceSection: "2.3",
  },
  {
    conditionPattern: /fever|hotness|malaria/,
    match: (t) => /malaria.*positive|positive.*malaria/.test(t) && /anaemia|anemia|thrombocytopenia|severe/.test(t),
    condition: "Hotness of Body (Acute Fever Syndromes)",
    branch: "Severe malaria or malaria with anaemia/thrombocytopenia",
    severity: "critical",
    disposition: "admit",
    summary: "Malaria with severity features.",
    sourceSection: "2.1",
  },
  {
    conditionPattern: /fever|hotness|malaria/,
    match: (t) => /malaria.*positive|positive.*malaria/.test(t) && /granulocytosis/.test(t),
    condition: "Hotness of Body (Acute Fever Syndromes)",
    branch: "Mixed bacterial infection and malaria",
    severity: "urgent",
    disposition: "admit",
    summary: "Mixed bacterial infection and malaria.",
    sourceSection: "2.1",
  },
  {
    conditionPattern: /fever|hotness|malaria/,
    match: (t) => /malaria.*positive|positive.*malaria/.test(t),
    condition: "Hotness of Body (Acute Fever Syndromes)",
    branch: "Uncomplicated malaria",
    severity: "routine",
    disposition: "outpatient",
    summary: "Uncomplicated malaria when no danger signs are present.",
    sourceSection: "2.1",
  },
  {
    conditionPattern: /fever|hotness|pneumonia|fast breathing|difficult breathing/,
    match: (t) => /fast breathing|difficult breathing|chest indrawing|pneumonia/.test(t),
    condition: "Hotness of Body (Acute Fever Syndromes)",
    branch: "Fever with fast or difficult breathing in child over 60 days",
    severity: "urgent",
    disposition: "depends_on_severity",
    summary: "WHO pneumonia severity classification.",
    missing: ["age_days", "danger signs", "chest indrawing", "tachypnoea", "ability to feed"],
    sourceSection: "2.4",
  },
  {
    conditionPattern: /fever|ear pain|otitis|ear discharge|mastoid/,
    match: (t) => /ear pain|otitis|otorrhoea|mastoid/.test(t),
    condition: "Hotness of Body (Acute Fever Syndromes)",
    branch: "Fever with ear pain / otitis media",
    severity: "urgent",
    disposition: "depends_on_age_and_complications",
    summary: "Otitis media pathway.",
    missing: ["age_months", "complicated otitis signs"],
    sourceSection: "2.5",
  },
  {
    conditionPattern: /fever|dysuria|urinary|flank|pyuria|haematuria|hematuria/,
    match: (t) => /dysuria|urinary|flank|pyuria|haematuria|hematuria/.test(t),
    condition: "Hotness of Body (Acute Fever Syndromes)",
    branch: "Fever with dysuria and urinary symptoms",
    severity: "urgent",
    disposition: "depends_on_complication",
    summary: "Urinary tract infection pathway.",
    sourceSection: "2.6",
  },

  {
    conditionPattern: /head injury|head trauma|gcs|traumatic brain/,
    match: (t) => (gcs(t) ?? 99) < 8,
    condition: "Head Injury",
    branch: "GCS below 8",
    severity: "critical",
    disposition: "admit_high_level_care",
    summary: "Severe head injury.",
    sourceSection: "4.3",
  },
  {
    conditionPattern: /head injury|head trauma|gcs|traumatic brain/,
    match: (t) => (gcs(t) ?? 99) >= 8 && (gcs(t) ?? 0) <= 12,
    condition: "Head Injury",
    branch: "GCS 8 to 12",
    severity: "critical",
    disposition: "admit",
    summary: "Moderate head injury.",
    sourceSection: "4.2",
  },
  {
    conditionPattern: /head injury|head trauma|gcs|traumatic brain/,
    match: (t) => (gcs(t) ?? 0) >= 13 || /vomit|convulsion|confusion|csf|penetrating|fracture|blurred vision|anisocoria|under 5|over 60/.test(t),
    condition: "Head Injury",
    branch: "GCS 13 or above with associated features",
    severity: "urgent",
    disposition: "admit",
    summary: "Mild head injury with high-risk features.",
    sourceSection: "4.1",
  },

  {
    conditionPattern: /abdominal injury|abdominal trauma|penetrating abdomen|blunt abdomen/,
    match: (t) => has(t, SHOCK),
    condition: "Abdominal Injury",
    branch: "Abdominal injury with signs of shock",
    severity: "critical",
    disposition: "admit",
    summary: "Abdominal trauma with shock.",
    sourceSection: "5.1",
  },
  {
    conditionPattern: /abdominal injury|abdominal trauma|penetrating abdomen|blunt abdomen/,
    match: (t) => !has(t, SHOCK),
    condition: "Abdominal Injury",
    branch: "Haemodynamically stable abdominal injury",
    severity: "urgent",
    disposition: "admit_observe",
    summary: "Stable abdominal trauma.",
    sourceSection: "5.2",
  },

  {
    conditionPattern: /chest trauma|chest injury|thoracic trauma|pneumothorax|haemothorax|hemothorax/,
    match: (t) => has(t, SHOCK) && /hyper-?resonant|hyperresonant/.test(t),
    condition: "Chest Trauma",
    branch: "Chest trauma with shock and hyper-resonant percussion note",
    severity: "critical",
    disposition: "admit",
    summary: "Tension pneumothorax.",
    sourceSection: "6.2",
  },
  {
    conditionPattern: /chest trauma|chest injury|thoracic trauma|pneumothorax|haemothorax|hemothorax/,
    match: (t) => has(t, SHOCK) && /dull percussion|dull note/.test(t),
    condition: "Chest Trauma",
    branch: "Chest trauma with shock and dull percussion note",
    severity: "critical",
    disposition: "admit",
    summary: "Possible haemothorax.",
    sourceSection: "6.3",
  },
  {
    conditionPattern: /chest trauma|chest injury|thoracic trauma/,
    match: (t) => has(t, SHOCK),
    condition: "Chest Trauma",
    branch: "Chest trauma with shock and normal percussion note",
    severity: "critical",
    disposition: "admit",
    summary: "Blunt chest trauma with haemodynamic compromise.",
    sourceSection: "6.1",
  },
  {
    conditionPattern: /chest trauma|chest injury|thoracic trauma/,
    match: (t) => !has(t, SHOCK),
    condition: "Chest Trauma",
    branch: "Chest trauma without shock",
    severity: "urgent",
    disposition: "admit_observe",
    summary: "Stable blunt chest trauma.",
    sourceSection: "6.4",
  },

  {
    conditionPattern: /epigastric|upper abdominal|gastritis|peptic|h pylori|haematemesis|hematemesis|bloody vomit/,
    match: (t) => /bloody vomit|haematemesis|hematemesis/.test(t) && has(t, SHOCK),
    condition: "Epigastric Pain",
    branch: "Epigastric pain with bloody vomitus and shock",
    severity: "critical",
    disposition: "admit",
    summary: "Presumed upper gastrointestinal bleeding with shock.",
    sourceSection: "7.1",
  },
  {
    conditionPattern: /epigastric|upper abdominal|gastritis|peptic|h pylori|haematemesis|hematemesis|bloody vomit/,
    match: (t) => /bloody vomit|haematemesis|hematemesis/.test(t),
    condition: "Epigastric Pain",
    branch: "Epigastric pain with bloody vomitus but no shock",
    severity: "urgent",
    disposition: "admit",
    summary: "Upper gastrointestinal bleeding without shock.",
    sourceSection: "7.2",
  },
  {
    conditionPattern: /epigastric|upper abdominal|gastritis|peptic|vomit/,
    match: (t) => /vomit/.test(t) && has(t, SHOCK),
    condition: "Epigastric Pain",
    branch: "Epigastric pain with non-bloody vomitus and shock",
    severity: "critical",
    disposition: "admit",
    summary: "Severe gastritis or peptic ulcer disease with shock.",
    sourceSection: "7.3",
  },
  {
    conditionPattern: /epigastric|upper abdominal|gastritis|peptic|h pylori/,
    match: (t) => /h\.?\s*pylori.*positive|positive.*h\.?\s*pylori/.test(t),
    condition: "Epigastric Pain",
    branch: "Stable mild epigastric pain with positive H. pylori",
    severity: "routine",
    disposition: "outpatient",
    summary: "Stable mild epigastric pain with H. pylori.",
    sourceSection: "7.4",
  },
  {
    conditionPattern: /epigastric|upper abdominal|gastritis|peptic|h pylori/,
    match: (t) => /h\.?\s*pylori.*negative|negative.*h\.?\s*pylori/.test(t) || !has(t, SHOCK),
    condition: "Epigastric Pain",
    branch: "Stable mild epigastric pain with negative H. pylori",
    severity: "routine",
    disposition: "outpatient",
    summary: "Stable mild epigastric pain without H. pylori.",
    missing: ["H. pylori result if not already known"],
    sourceSection: "7.4",
  },

  {
    conditionPattern: /burn|tbsa|scald|thermal|chemical|electrical/,
    match: (t) => /electrical|chemical|inhalation|circumferential|concomitant trauma|comorbid/.test(t) || (/full thickness/.test(t) && (tbsa(t) ?? 0) > 10) || (/partial/.test(t) && ((ageYears(t) ?? 20) >= 10 && (ageYears(t) ?? 20) <= 50 ? (tbsa(t) ?? 0) > 25 : (tbsa(t) ?? 0) > 20)),
    condition: "Burns",
    branch: "Severe burn injury",
    severity: "critical",
    disposition: "specialised_unit",
    summary: "Burn requiring specialised unit or intensive care.",
    sourceSection: "9.3",
  },
  {
    conditionPattern: /burn|tbsa|scald|thermal/,
    match: (t) => specialAreaBurnPresent(t) || (/full thickness/.test(t) && (tbsa(t) ?? 0) >= 2) || (/partial/.test(t) && ((ageYears(t) ?? 20) >= 10 && (ageYears(t) ?? 20) <= 50 ? (tbsa(t) ?? 0) >= 15 : (tbsa(t) ?? 0) >= 10)),
    condition: "Burns",
    branch: "Moderate burn injury",
    severity: "urgent",
    disposition: "admit",
    summary: "Burn requiring admission.",
    sourceSection: "9.2",
  },
  {
    conditionPattern: /burn|tbsa|scald|thermal/,
    match: () => true,
    condition: "Burns",
    branch: "Mild burn injury",
    severity: "routine",
    disposition: "outpatient",
    summary: "Burn suitable for outpatient management if TBSA/depth criteria are mild and no special-area or severe features are present.",
    missing: ["age_years", "burn_depth", "tbsa_percent", "special_area_burn"],
    sourceSection: "9.1",
  },

  {
    conditionPattern: /hyperkalaemia|hyperkalemia|high potassium|potassium|k\+/,
    match: (t) => /hyperkalaemia|hyperkalemia|high potassium/.test(t) || (potassium(t) ?? 0) > 5,
    condition: "Hyperkalaemia Management",
    branch: "Confirmed hyperkalaemia stepwise management",
    severity: "critical",
    disposition: "depends_on_response",
    summary: "Stepwise hyperkalaemia management.",
    sourceSection: "10",
  },
  {
    conditionPattern: /dka|diabetic ketoacidosis|ketone|kussmaul|polyuria|polydipsia/,
    match: (t) => /dka|diabetic ketoacidosis|ketone|kussmaul/.test(t) || ((bloodGlucose(t) ?? 0) > 11 && ((ph(t) ?? 9) < 7.3 || (bicarbonate(t) ?? 99) < 15)),
    condition: "Diabetic Ketoacidosis Management",
    branch: "DKA fluid, insulin, electrolyte, and monitoring protocol",
    severity: "critical",
    disposition: "admit",
    summary: "DKA management when compatible symptoms/labs are present.",
    sourceSection: "12",
  },
  {
    conditionPattern: /neonate fluid|neonatal fluid|newborn fluid/,
    match: () => true,
    condition: "Fluid Management in Neonates and Children",
    branch: "Fluid management in neonates",
    severity: "urgent",
    disposition: "protocol",
    summary: "Neonatal maintenance fluid protocol.",
    sourceSection: "13",
  },
  {
    conditionPattern: /dehydration|ors|plan a|plan b|plan c|diarrhoea|diarrhea/,
    match: (t) => /severe dehydration|plan c|letharg|unconscious|drinking poorly/.test(t),
    condition: "Fluid Management in Neonates and Children",
    branch: "Child severe dehydration: Plan C",
    severity: "critical",
    disposition: "urgent_rehydration",
    summary: "Plan C IV rehydration.",
    sourceSection: "13",
  },
  {
    conditionPattern: /dehydration|ors|plan a|plan b|diarrhoea|diarrhea/,
    match: (t) => /some dehydration|plan b|restless|irritable|sunken eyes|drinking eagerly|slow skin pinch/.test(t),
    condition: "Fluid Management in Neonates and Children",
    branch: "Child some dehydration: Plan B",
    severity: "urgent",
    disposition: "observe_reassess",
    summary: "Plan B rehydration.",
    sourceSection: "13",
  },
  {
    conditionPattern: /dehydration|ors|plan a|diarrhoea|diarrhea/,
    match: () => true,
    condition: "Fluid Management in Neonates and Children",
    branch: "Child no dehydration: Plan A",
    severity: "routine",
    disposition: "outpatient",
    summary: "Plan A oral fluid management.",
    sourceSection: "13",
  },
  {
    conditionPattern: /hypernatraemia|hypernatremia|high sodium|sodium/,
    match: (t) => /hypernatraemia|hypernatremia|high sodium/.test(t) || (sodium(t) ?? 0) > 150,
    condition: "Hypernatraemia Treatment",
    branch: "Hypernatraemia treatment",
    severity: "critical",
    disposition: "admit_monitor",
    summary: "Controlled correction of sodium above 150 mmol/L.",
    sourceSection: "14",
  },
  {
    conditionPattern: /hyponatraemia|hyponatremia|low sodium|sodium/,
    match: (t) => {
      const value = sodium(t);
      return /hyponatraemia|hyponatremia|low sodium/.test(t) || (value !== null && value > 0 && value < 130);
    },
    condition: "Hyponatraemia Treatment",
    branch: "Hyponatraemia emergency and volume-status management",
    severity: "critical",
    disposition: "admit_monitor",
    summary: "Emergency treatment and volume status approach for hyponatraemia.",
    sourceSection: "15",
  },
  {
    conditionPattern: /postpartum haemorrhage|postpartum hemorrhage|pph|caesarean blood loss|cesarean blood loss/,
    match: (t) => /pph|postpartum/.test(t) || (pphBloodLoss(t) ?? 0) >= 500,
    condition: "High-Risk Obstetric Conditions (Postpartum Haemorrhage Risk Assessment)",
    branch: "Postpartum haemorrhage risk assessment and immediate response",
    severity: "critical",
    disposition: "prepare_or_resuscitate",
    summary: "PPH risk factors and immediate response.",
    sourceSection: "Appendix",
  },
];

export async function buildPathwayGuardedAnswer(question: string, documents: Document[], currentQuestion = question) {
  const text = normalizeClinicalText(question);

  const tableDrivenAnswer = await buildTableDrivenAnswer(question, documents, currentQuestion);
  if (tableDrivenAnswer) return tableDrivenAnswer;

  const rule = RULES.find((candidate) => candidate.conditionPattern.test(text) && candidate.match(text));
  if (!rule) return null;
  const details = await getPathwayDetailsByTitle(rule.branch);

  if (rule.condition === "Burns" && rule.branch === "Mild burn injury") {
    const missing = missingBurnFacts(text);
    if (missing.length) return formatGuard({ ...rule, missing }, documents, details);
  }

  const wantsDiagnostics = asksForDiagnostics(currentQuestion.toLowerCase());
  const wantsTreatment = asksForTreatment(currentQuestion.toLowerCase());
  const wantsInsulin = asksForInsulin(currentQuestion.toLowerCase());

  if (wantsInsulin) {
    const focusedAnswer = formatFocusedManagementFollowUp(rule, documents, details, "insulin");
    if (focusedAnswer) return focusedAnswer;
  }

  if (wantsDiagnostics && wantsTreatment) {
    return formatDiagnosticAndManagementFollowUp(rule, documents, details);
  }

  if (wantsDiagnostics) {
    return formatDiagnosticFollowUp(rule, documents, details);
  }

  if (wantsTreatment) {
    const managementAnswer = formatManagementFollowUp(rule, documents, details);
    if (managementAnswer) return managementAnswer;
  }

  return formatGuard(rule, documents, details);
}
