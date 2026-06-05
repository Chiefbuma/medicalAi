type Severity = "routine" | "urgent" | "critical";

type DifferentialRule = {
  id: string;
  condition: string;
  conditionPattern: RegExp;
  match: (facts: ClinicalFacts) => boolean;
  missing: (facts: ClinicalFacts) => string[];
  diagnosis: string;
  disposition: string;
  severity: Severity;
  tests?: string[];
  management: string;
  source: string;
};

type ClinicalFacts = ReturnType<typeof extractClinicalFacts>;

const shockPattern = /shock|hypotension|tachycardia|weak thready pulse|delayed capillary refill|cold|clammy|collapse|faint|altered consciousness|poor perfusion/;
const stablePattern = /no shock|without shock|not in shock|haemodynamically stable|hemodynamically stable|stable/;
const associatedHeadFeaturesPattern =
  /convulsion|seizure|confusion|csf|otorrhoea|rhinorrhoea|penetrating|palpable fracture|fracture|deformity|blurred vision|vomit|anisocoria|lateralising|lateralizing|age under 5|under 5|age over 60|over 60/;
const noAssociatedHeadFeaturesPattern =
  /no associated|without associated|no convulsion|no seizure|no confusion|no csf|no vomiting|no blurred vision|no fracture|no anisocoria|no lateralising|no lateralizing/;

function firstNumber(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.groups?.value || match?.[2] || match?.[1];
    if (!value) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function activeClinicalText(input: string) {
  const standalone = input.match(
    /Use these current patient facts as the active case:\n([\s\S]*?)\nCurrent doctor question\/update:\s*([\s\S]*)$/i,
  );
  if (standalone) {
    return `${standalone[1].trim()}\n${standalone[2].trim()}`;
  }

  const sameSession = input.match(
    /Updated case memory including current message:\n([\s\S]*?)\nCurrent doctor message:\s*([\s\S]*)$/i,
  );
  if (sameSession) {
    return `${sameSession[1].trim()}\n${sameSession[2].trim()}`;
  }

  return input;
}

function booleanFact(text: string, positive: RegExp, negative: RegExp) {
  if (negative.test(text)) return false;
  if (positive.test(text)) return true;
  return undefined;
}

function testResult(text: string, subject: RegExp) {
  const positive = new RegExp(`(?:${subject.source}).{0,50}(?:positive|\\+|detected|reactive)|(?:positive|\\+|detected|reactive).{0,50}(?:${subject.source})`);
  const negative = new RegExp(`(?:${subject.source}).{0,50}(?:negative|not detected|non-reactive|non reactive|absent)|(?:negative|not detected|non-reactive|non reactive|absent).{0,50}(?:${subject.source})`);
  if (negative.test(text)) return "negative";
  if (positive.test(text)) return "positive";
  return undefined;
}

function highLowStatus(text: string, subject: RegExp) {
  const high = new RegExp(`(?:${subject.source}).{0,50}(?:high|raised|elevated|above normal|above range|more than normal|increased)|(?:high|raised|elevated|above normal|above range|increased).{0,50}(?:${subject.source})`);
  const low = new RegExp(`(?:${subject.source}).{0,50}(?:low|reduced|below normal|below range|less than normal|decreased)|(?:low|reduced|below normal|below range|decreased).{0,50}(?:${subject.source})`);
  const normal = new RegExp(`(?:${subject.source}).{0,50}(?:normal|within normal|within range)|(?:normal|within normal|within range).{0,50}(?:${subject.source})`);
  if (high.test(text)) return "high";
  if (low.test(text)) return "low";
  if (normal.test(text)) return "normal";
  return undefined;
}

function comparativeStatus(text: string, subject: RegExp, threshold: number, unit?: RegExp) {
  const unitPart = unit ? `\\s*(?:${unit.source})` : "";
  const above = new RegExp(
    `(?:${subject.source}).{0,30}(?:above|over|more than|greater than|>|>=)\\s*${threshold}${unitPart}|(?:above|over|more than|greater than|>|>=)\\s*${threshold}${unitPart}.{0,30}(?:${subject.source})`,
  );
  const below = new RegExp(
    `(?:${subject.source}).{0,30}(?:below|under|less than|lower than|<|<=)\\s*${threshold}${unitPart}|(?:below|under|less than|lower than|<|<=)\\s*${threshold}${unitPart}.{0,30}(?:${subject.source})`,
  );
  const equalOrAbove = new RegExp(
    `(?:${subject.source}).{0,30}(?:at least|not less than|>=)\\s*${threshold}${unitPart}|(?:at least|not less than|>=)\\s*${threshold}${unitPart}.{0,30}(?:${subject.source})`,
  );
  const equalOrBelow = new RegExp(
    `(?:${subject.source}).{0,30}(?:at most|not more than|<=)\\s*${threshold}${unitPart}|(?:at most|not more than|<=)\\s*${threshold}${unitPart}.{0,30}(?:${subject.source})`,
  );
  if (above.test(text)) return "above";
  if (below.test(text)) return "below";
  if (equalOrAbove.test(text)) return "at_least";
  if (equalOrBelow.test(text)) return "at_most";
  return undefined;
}

function cbcStatus(text: string) {
  if (/granulocytosis|neutrophilia|leucocytosis|leukocytosis|high white cell|high wbc|wbc high|white cell.*high/.test(text)) {
    return "granulocytosis";
  }
  if (/lymphocytosis/.test(text)) return "lymphocytosis";
  if (/thrombocytopenia|low platelet|platelet.*low|platelets.*low/.test(text)) return "thrombocytopenia";
  if (
    /anaemia|anemia|low haemoglobin|low hemoglobin|low hb|hb low|haemoglobin.*low|hemoglobin.*low|blood count.*low|low blood count|cbc.*low|fbc.*low|(?:cbc|fbc|blood count).*?(?:less than|below|<)\s*\d/.test(
      text,
    )
  ) {
    return "anaemia";
  }
  if (/normal.*(?:cbc|fbc|blood count)|(?:cbc|fbc|blood count).*normal/.test(text)) return "normal";
  return undefined;
}

function extractClinicalFacts(input: string) {
  const text = activeClinicalText(input).toLowerCase();
  const ageYears = firstNumber(text, [
    /(?:age|aged)?\s*(\d{1,3})\s*(?:years|year|yrs|yr)\b/,
    /(?:age|aged)\s*(?:is|=|:)?\s*(\d{1,3})\b/,
  ]);
  const ageMonths = firstNumber(text, [/(\d{1,2})\s*(?:months|month|mos|mo)\b/]);
  const ageDays = firstNumber(text, [/(\d{1,3})\s*(?:days|day)\b/]);
  const gestationWeeks = /pregnan|gestation|weeks pregnant/.test(text)
    ? firstNumber(text, [/(\d{1,2})\s*(?:weeks|wks)/])
    : null;
  const gcs = firstNumber(text, [
    /\bgcs\s*(?:is|=|:)?\s*(\d{1,2})\b/,
    /glasgow coma scale\s*(?:is|=|:)?\s*(\d{1,2})\b/,
  ]);
  const tbsa = firstNumber(text, [
    /(\d{1,3})\s*%/,
    /(\d{1,3})\s*(?:percent|per cent).*?(?:tbsa|body surface|burn)/,
  ]);
  const potassium = firstNumber(text, [/(?:potassium|k\+).*?(\d+(?:\.\d+)?)/]);
  const sodium = firstNumber(text, [/(?:sodium|na\+).*?(\d+(?:\.\d+)?)/]);
  const glucose = firstNumber(text, [/(?:glucose|blood sugar).*?(\d+(?:\.\d+)?)/]);
  const ph = firstNumber(text, [/\bpH\s*(?:is|=|:)?\s*(\d+(?:\.\d+)?)/i]);
  const bicarbonate = firstNumber(text, [/(?:bicarbonate|hco3).*?(\d+(?:\.\d+)?)/]);
  const haemoglobin =
    firstNumber(text, [/(?:haemoglobin|hemoglobin|hb).*?(\d+(?:\.\d+)?)/]) ??
    firstNumber(text, [
      /(?:cbc|fbc|blood count).*?(?:less than|below|<)\s*(\d+(?:\.\d+)?)/,
      /(?:less than|below|<)\s*(\d+(?:\.\d+)?).*?(?:cbc|fbc|blood count)/,
    ]);
  const bloodLossMl = firstNumber(text, [/(\d{3,4})\s*(?:ml|millilit)/]);
  const ageDay60 = comparativeStatus(text, /age|aged|child|infant|baby|neonate|newborn/, 60, /days?|day/);
  const ageMonth3 = comparativeStatus(text, /age|aged|child|infant|baby/, 3, /months?|mos?|mo/);
  const ageMonth6 = comparativeStatus(text, /age|aged|child|infant|baby/, 6, /months?|mos?|mo/);
  const gestation20 = comparativeStatus(text, /gestation|pregnan|weeks pregnant/, 20, /weeks?|wks?/);

  const shock = booleanFact(text, shockPattern, stablePattern);
  const pregnant = booleanFact(
    text,
    /pregnan|gestation|antenatal|weeks pregnant/,
    /not pregnant|non-pregnant|non pregnant|pregnancy test negative|negative pregnancy test/,
  );
  const activeBleeding = booleanFact(
    text,
    /active bleeding|ongoing bleeding|still bleeding|continued bleeding|fresh bleeding|heavy bleeding|bleeding/,
    /bleeding stopped|bleeding resolved|no active bleeding|no bleeding|resolved|dry pad/,
  );
  const malaria = testResult(text, /malaria|mps|rdt|antigen/);
  const cbc = cbcStatus(text);
  const potassiumStatus = highLowStatus(text, /potassium|k\+/);
  const sodiumStatus = highLowStatus(text, /sodium|na\+/);
  const glucoseStatus = highLowStatus(text, /glucose|blood sugar|rbs|random blood sugar/);
  const hPylori = testResult(text, /h\.?\s*pylori|helicobacter pylori/);

  return {
    text,
    ageYears,
    ageMonths,
    ageDays,
    gestationWeeks,
    gcs,
    tbsa,
    potassium,
    sodium,
    glucose,
    ph,
    bicarbonate,
    haemoglobin,
    bloodLossMl,
    ageDay60,
    ageMonth3,
    ageMonth6,
    gestation20,
    potassiumStatus,
    sodiumStatus,
    glucoseStatus,
    shock,
    pregnant,
    activeBleeding,
    malaria,
    cbc,
    neurological: booleanFact(
      text,
      /confusion|hallucination|abnormal posturing|reduced consciousness|unconscious|letharg|drows/,
      /no neurological|without neurological|normal mental state|alert|no confusion|not confused|conscious/,
    ),
    convulsions: booleanFact(text, /convulsion|seizure|fits?/, /no convulsion|no seizure|without convulsion|without seizure|no fits?/),
    respiratory: booleanFact(
      text,
      /fast breathing|difficulty breathing|difficult breathing|pneumonia|chest indrawing|wheeze|respiratory distress|cough/,
      /no respiratory distress|no wheeze|no fast breathing|no difficult breathing|no chest indrawing|normal breathing/,
    ),
    urinary: booleanFact(
      text,
      /dysuria|urinary|flank pain|suprapubic|haematuria|hematuria|pyuria/,
      /no dysuria|no urinary|no flank pain|no suprapubic|no haematuria|no hematuria|no pyuria/,
    ),
    earPain: booleanFact(text, /ear pain|otitis|otorrhoea|mastoid/, /no ear pain|no otitis|no otorrhoea|no ear discharge|no mastoid/),
    targetOrgan: booleanFact(
      text,
      /severe headache|blurred vision|epigastric pain|oliguria|liver tenderness|target organ|seizure/,
      /no target organ|without target organ|no severe headache|no blurred vision|no epigastric pain|no oliguria|no liver tenderness/,
    ),
    severeHypertension: /\b1[6-9]\d\s*\/|\/\s*1[1-9]\d\b|180\s*\/\s*110/.test(text),
    mildHypertension: /140\s*\/\s*90|hypertension|high blood pressure|elevated blood pressure/.test(text),
    associatedHeadFeatures: noAssociatedHeadFeaturesPattern.test(text)
      ? false
      : associatedHeadFeaturesPattern.test(text)
        ? true
        : undefined,
    burnDepth: /full thickness|third degree/.test(text)
      ? "full"
      : /partial thickness|second degree/.test(text)
        ? "partial"
        : /superficial|first degree/.test(text)
          ? "superficial"
          : undefined,
    specialAreaBurn: booleanFact(
      text,
      /face|hands?|feet|foot|genitalia|perineum|major joints?|head/,
      /no special area|not.*(?:face|hand|feet|foot|genitalia|perineum|joint)|no.*(?:face|hand|feet|foot|genitalia|perineum|joint)/,
    ),
    burnHighRisk: /electrical|chemical|inhalation|circumferential|concomitant trauma|comorbid|pre-existing/.test(text),
    bloodyVomitus: booleanFact(text, /bloody vomit|vomit.*blood|haematemesis|hematemesis/, /non-bloody vomit|no bloody vomit|no blood in vomit|no haematemesis|no hematemesis/),
    vomiting: booleanFact(text, /vomit|emesis/, /no vomiting|not vomiting|without vomiting|denies vomiting|vomiting resolved|vomiting stopped/),
    hPylori,
    percussion: /hyper-?resonant|hyperresonant/.test(text) ? "hyper-resonant" : /dull percussion|dull note/.test(text) ? "dull" : /normal percussion|normal note/.test(text) ? "normal" : undefined,
    dehydration: /no dehydration|plan a/.test(text)
      ? "none"
      : /moderate dehydration|some dehydration|plan b|4-6%|4\s*to\s*6%|delayed capillary refill/.test(text)
        ? "some"
        : /severe dehydration|plan c|6%|shock|mottled|deep acidotic/.test(text)
          ? "severe"
          : undefined,
    volumeStatus: /hypovolaemic|hypovolemic/.test(text)
      ? "hypovolemic"
      : /euvolemic/.test(text)
        ? "euvolemic"
        : /hypervolemic|oedema|edema|raised jvp/.test(text)
          ? "hypervolemic"
          : undefined,
  };
}

function conditionMentioned(facts: ClinicalFacts, pattern: RegExp) {
  return pattern.test(facts.text);
}

function missingFacts(facts: ClinicalFacts, required: Array<[string, boolean]>) {
  return required.filter(([, known]) => !known).map(([fact]) => fact);
}

function headInjuryMissing(facts: ClinicalFacts) {
  if (facts.gcs === null) return ["gcs"];
  if (facts.gcs >= 13 && facts.associatedHeadFeatures === undefined) return ["associated_features"];
  return [];
}

function burnBand(facts: ClinicalFacts) {
  const age = facts.ageYears;
  const tbsa = facts.tbsa;
  if (facts.burnHighRisk) return "severe";
  if (facts.specialAreaBurn === true) return "moderate";
  if (facts.burnDepth === "full" && tbsa !== null) {
    if (tbsa > 10) return "severe";
    if (tbsa >= 2) return "moderate";
    return "mild";
  }
  if (facts.burnDepth === "partial" && tbsa !== null && age !== null) {
    if (age >= 10 && age <= 50) {
      if (tbsa > 25) return "severe";
      if (tbsa >= 15) return "moderate";
      return "mild";
    }
    if (tbsa > 20) return "severe";
    if (tbsa >= 10) return "moderate";
    return "mild";
  }
  return null;
}

function asthmaSeverity(facts: ClinicalFacts) {
  const text = facts.text;
  if (/drows|confus|paradoxical thoracoabdominal|absence of wheeze|silent chest|bradycardia/.test(text)) return "failure";
  if (/sitting upright|agitat|pulse.*(?:above|>)\s*120|pulsus.*(?:25|20.*40)|loud.*(?:inhalation|inspiration).*exhalation/.test(text)) return "severe";
  if (/accessory muscle|loud wheeze throughout exhalation|pulse.*100\s*(?:to|-)\s*120|pulsus.*10\s*(?:to|-)\s*25/.test(text)) return "moderate";
  if (/normal mental state|talk.*sentences|end[- ]expiration|pulse.*(?:below|<)\s*100|pulsus.*(?:absent|below 10|<\s*10)/.test(text)) return "mild";
  return null;
}

const rules: DifferentialRule[] = [
  {
    id: "pvb_non_pregnant_shock",
    condition: "Per vaginal bleeding",
    conditionPattern: /vaginal bleeding|pv bleeding|per vaginal|uterine bleeding|bleeding/,
    match: (f) => f.pregnant === false && f.shock === true,
    missing: (f) => missingFacts(f, [["pregnancy status", f.pregnant !== undefined], ["shock status", f.shock !== undefined]]),
    diagnosis: "Abnormal uterine bleeding complicated by hypovolaemic shock.",
    disposition: "admit",
    severity: "critical",
    tests: ["Complete blood count", "Grouping and cross-match", "Pelvic ultrasound", "Coagulation profile/peripheral blood film if thrombocytopenia", "Liver function tests if granulocytosis"],
    management: "Immediate ABC stabilisation, secure IV access, start fluid resuscitation, send CBC and cross-match, arrange pelvic ultrasound, admit for gynaecological review. Give IV tranexamic acid 1 g three times daily, IV ceftriaxone 50 mg/kg, and IV metronidazole 7.5 mg/kg.",
    source: "1.1",
  },
  {
    id: "pvb_pregnant_under_20_shock",
    condition: "Per vaginal bleeding",
    conditionPattern: /vaginal bleeding|pv bleeding|per vaginal|pregnan.*bleed|bleed.*pregnan|abortion|miscarriage/,
    match: (f) =>
      f.pregnant === true &&
      f.shock === true &&
      ((f.gestationWeeks !== null && f.gestationWeeks < 20) || f.gestation20 === "below"),
    missing: (f) => missingFacts(f, [["pregnancy status", f.pregnant !== undefined], ["gestation weeks", f.gestationWeeks !== null || Boolean(f.gestation20)], ["shock status", f.shock !== undefined]]),
    diagnosis: "Abortion complicated by haemodynamic instability.",
    disposition: "admit",
    severity: "critical",
    tests: ["Obstetric ultrasound", "Complete blood count", "Coagulation profile as indicated"],
    management: "Use ABC resuscitation, obtain obstetric ultrasound, assess for infection, coagulopathy, and anaemia, admit for gynaecological review. Treat with IV tranexamic acid, ceftriaxone, and metronidazole as in section 1.1.",
    source: "1.2",
  },
  {
    id: "pvb_pregnant_over_20_shock",
    condition: "Per vaginal bleeding",
    conditionPattern: /vaginal bleeding|pv bleeding|per vaginal|pregnan.*bleed|bleed.*pregnan|antepartum/,
    match: (f) =>
      f.pregnant === true &&
      f.shock === true &&
      ((f.gestationWeeks !== null && f.gestationWeeks > 20) || f.gestation20 === "above"),
    missing: (f) => missingFacts(f, [["pregnancy status", f.pregnant !== undefined], ["gestation weeks", f.gestationWeeks !== null || Boolean(f.gestation20)], ["shock status", f.shock !== undefined]]),
    diagnosis: "Antepartum haemorrhage until proven otherwise.",
    disposition: "admit",
    severity: "critical",
    tests: ["Obstetric ultrasound", "Complete blood count", "Coagulation profile as indicated"],
    management: "Prioritise maternal stabilisation, urgent obstetric assessment and ultrasound, identify coagulopathy, anaemia, and infection early, admit for gynaecological review. Treat with IV tranexamic acid, ceftriaxone, and metronidazole as above.",
    source: "1.3",
  },
  {
    id: "pvb_stable_active",
    condition: "Per vaginal bleeding",
    conditionPattern: /vaginal bleeding|pv bleeding|per vaginal|uterine bleeding|bleeding/,
    match: (f) => f.shock === false && f.activeBleeding === true,
    missing: (f) => missingFacts(f, [["shock status", f.shock !== undefined], ["whether bleeding is ongoing or resolved", f.activeBleeding !== undefined]]),
    diagnosis: "Haemodynamically stable patient with ongoing bleeding.",
    disposition: "admit",
    severity: "urgent",
    tests: ["Complete blood count"],
    management: "Admit for specialist review. Give IV tranexamic acid, ceftriaxone, and metronidazole. Persistent blood-count abnormalities should prompt admission.",
    source: "1.4",
  },
  {
    id: "pvb_stable_resolved",
    condition: "Per vaginal bleeding",
    conditionPattern: /vaginal bleeding|pv bleeding|per vaginal|uterine bleeding|bleeding/,
    match: (f) => f.shock === false && f.activeBleeding === false,
    missing: (f) => missingFacts(f, [["shock status", f.shock !== undefined], ["whether bleeding is ongoing or resolved", f.activeBleeding !== undefined]]),
    diagnosis: "Haemodynamically stable patient with resolved bleeding.",
    disposition: "outpatient",
    severity: "routine",
    tests: ["Complete blood count if not already done"],
    management: "Outpatient management may be appropriate. Prescribe oral tranexamic acid 1 g three times daily, oral cefuroxime 50 mg/kg, and oral metronidazole 7.5 mg/kg. Arrange general outpatient follow-up.",
    source: "1.4",
  },
  {
    id: "fever_no_danger_normal_malaria_negative",
    condition: "Hotness of body",
    conditionPattern: /fever|hotness|pyrexia/,
    match: (f) => f.neurological !== true && f.convulsions !== true && f.cbc === "normal" && f.malaria === "negative" && !(f.haemoglobin !== null && f.haemoglobin < 10),
    missing: (f) => missingFacts(f, [["CBC result", Boolean(f.cbc)], ["malaria result", Boolean(f.malaria)]]),
    diagnosis: "Viral or self-limiting illness.",
    disposition: "outpatient",
    severity: "routine",
    tests: ["Complete blood count", "Malaria antigen test"],
    management: "Use antipyretics with paracetamol 10 mg/kg per dose, supportive care including tepid sponging, and follow-up review in 7 days.",
    source: "2.1",
  },
  {
    id: "fever_bacterial",
    condition: "Hotness of body",
    conditionPattern: /fever|hotness|pyrexia/,
    match: (f) => f.cbc === "granulocytosis" && f.malaria === "negative",
    missing: (f) => missingFacts(f, [["CBC result", Boolean(f.cbc)], ["malaria result", Boolean(f.malaria)]]),
    diagnosis: "Acute bacterial infection.",
    disposition: "outpatient",
    severity: "routine",
    tests: ["Complete blood count", "Malaria antigen test"],
    management: "Outpatient oral amoxicillin/clavulanate: over 12 years 375-750 mg; under 12 years 25-50 mg/kg/day, plus paracetamol. Follow up in 7 days.",
    source: "2.1",
  },
  {
    id: "fever_anaemia_malaria_negative",
    condition: "Hotness of body",
    conditionPattern: /fever|hotness|pyrexia/,
    match: (f) => f.malaria === "negative" && f.haemoglobin !== null && f.haemoglobin < 10,
    missing: (f) => missingFacts(f, [["malaria result", Boolean(f.malaria)], ["haemoglobin", f.haemoglobin !== null]]),
    diagnosis: "Possible anaemia complicating an acute febrile illness.",
    disposition: "admit",
    severity: "urgent",
    tests: ["Complete blood count", "Malaria antigen test"],
    management: "Admit for further workup and possible transfusion.",
    source: "2.1",
  },
  {
    id: "fever_uncomplicated_malaria",
    condition: "Hotness of body",
    conditionPattern: /fever|hotness|pyrexia|malaria/,
    match: (f) => f.malaria === "positive" && (f.cbc === "normal" || f.cbc === "lymphocytosis"),
    missing: (f) => missingFacts(f, [["malaria result", Boolean(f.malaria)], ["CBC result", Boolean(f.cbc)]]),
    diagnosis: "Uncomplicated malaria.",
    disposition: "outpatient",
    severity: "routine",
    tests: ["Complete blood count", "Malaria antigen test"],
    management: "Give outpatient oral artemether/lumefantrine by body weight with paracetamol. Follow up in 3 days.",
    source: "2.1",
  },
  {
    id: "fever_severe_malaria_or_mixed",
    condition: "Hotness of body",
    conditionPattern: /fever|hotness|pyrexia|malaria/,
    match: (f) => f.malaria === "positive" && (f.cbc === "granulocytosis" || f.cbc === "thrombocytopenia" || f.cbc === "anaemia" || (f.haemoglobin !== null && f.haemoglobin < 10)),
    missing: (f) => missingFacts(f, [["malaria result", Boolean(f.malaria)], ["CBC or haemoglobin severity result", Boolean(f.cbc) || f.haemoglobin !== null]]),
    diagnosis: "Malaria with bacterial infection or severity features.",
    disposition: "admit",
    severity: "urgent",
    tests: ["Complete blood count", "Malaria antigen test"],
    management: "Admit for parenteral treatment. If granulocytosis with malaria, give artesunate 2.4 mg/kg loading dose, paracetamol, and ceftriaxone 50 mg/kg. Transfuse if haemoglobin is below 5 g/dL and give oral ranferon when haemoglobin is above 6 g/dL.",
    source: "2.1",
  },
  {
    id: "fever_neurological",
    condition: "Hotness of body",
    conditionPattern: /fever|hotness|pyrexia|confusion|hallucination|abnormal posturing/,
    match: (f) => f.neurological === true,
    missing: () => [],
    diagnosis: "Fever with neurological symptoms: CNS infection, metabolic derangement, or severe malaria must be considered.",
    disposition: "admit",
    severity: "critical",
    tests: ["Complete blood count", "Malaria antigen", "Renal function tests", "Random blood sugar", "Lumbar puncture when appropriate"],
    management: "Admit for close monitoring, further evaluation including lumbar puncture when appropriate, IV ceftriaxone 100 mg/kg twice daily, paracetamol, seizure control if needed, and specialist consultation.",
    source: "2.2",
  },
  {
    id: "fever_under_60_days_convulsions",
    condition: "Hotness of body",
    conditionPattern: /fever|hotness|pyrexia|convulsion|seizure/,
    match: (f) => ((f.ageDays !== null && f.ageDays < 60) || f.ageDay60 === "below") && f.convulsions === true,
    missing: (f) => missingFacts(f, [["age in days", f.ageDays !== null || Boolean(f.ageDay60)], ["convulsions present or absent", /convulsion|seizure|no convulsion|no seizure/.test(f.text)]]),
    diagnosis: "Possible neonatal sepsis or meningitis.",
    disposition: "admit",
    severity: "critical",
    tests: ["Full septic workup", "Lumbar puncture if no signs of raised intracranial pressure", "Malaria test", "Random blood sugar"],
    management: "Admit. Give ceftriaxone 100 mg/kg per dose, paracetamol as needed, and seizure management per appendix. If malaria positive add artesunate 3 mg/kg per dose. If hypoglycaemia is present give 5 mL/kg of 10% dextrose stat.",
    source: "2.3",
  },
  {
    id: "pneumonia_child_over_60_days",
    condition: "Hotness of body",
    conditionPattern: /pneumonia|fast breathing|difficult breathing|difficulty breathing|chest indrawing|cough/,
    match: (f) => f.respiratory === true && ((f.ageDays !== null && f.ageDays > 60) || f.ageDay60 === "above"),
    missing: (f) => missingFacts(f, [["age in days", f.ageDays !== null || Boolean(f.ageDay60)], ["pneumonia severity signs", /very severe|severe pneumonia|non-severe|chest indrawing|tachypnoea|fast breathing|central cyanosis|unable to feed|convulsion|letharg/.test(f.text)]]),
    diagnosis: "Fever with fast or difficult breathing in child over 60 days.",
    disposition: "depends_on_severity",
    severity: "urgent",
    tests: [],
    management: "Very severe pneumonia: admit for oxygen and IV amoxicillin/clavulanate 40 mg/kg/day plus IV paracetamol. Severe pneumonia: admit for IV amoxicillin/clavulanate 40 mg/kg/day and IV paracetamol. Non-severe pneumonia: outpatient oral amoxicillin/clavulanate 40 mg/kg/day plus paracetamol and follow up in 2 days. No pneumonia: no antibiotics; symptomatic outpatient care and follow up in 5 days.",
    source: "2.4",
  },
  {
    id: "fever_otitis",
    condition: "Hotness of body",
    conditionPattern: /ear pain|otitis|otorrhoea|mastoid/,
    match: (f) => f.earPain === true,
    missing: (f) => missingFacts(f, [["age in months", f.ageMonths !== null || f.ageDays !== null || Boolean(f.ageMonth3) || Boolean(f.ageMonth6)], ["complicated ear signs", /otorrhoea|mastoid|cranial nerve|complicated|uncomplicated/.test(f.text)]]),
    diagnosis: "Fever with ear pain / otitis media.",
    disposition: "depends_on_age_and_complications",
    severity: "urgent",
    tests: [],
    management: "Child under 3 months with fever, complicated infection, or age 3-6 months with fever: admit for IV amoxicillin/clavulanate 40 mg/kg per dose and IV paracetamol. Child over 6 months with uncomplicated otitis and no danger signs: outpatient oral amoxicillin/clavulanate 45 mg/kg per dose plus paracetamol.",
    source: "2.5",
  },
  {
    id: "fever_uti",
    condition: "Hotness of body",
    conditionPattern: /dysuria|urinary|flank pain|suprapubic|haematuria|hematuria|pyuria/,
    match: (f) => f.urinary === true,
    missing: () => [],
    diagnosis: "Urinary tract infection pathway.",
    disposition: "depends_on_complication",
    severity: "urgent",
    tests: ["Urinalysis"],
    management: "Stable uncomplicated infection: outpatient oral cefuroxime 50 mg/kg per dose plus paracetamol, follow up in 7 days. Complicated infection with flank pain, suprapubic tenderness, frank haematuria, vomiting, or pyuria: admit for IV ciprofloxacin; 4 mg/kg per dose for infants 1 month to 1 year, maximum 400 mg, or 6 mg/kg per dose for children 1 to 18 years. Avoid ciprofloxacin in pregnancy.",
    source: "2.6",
  },
  {
    id: "bp_pregnancy",
    condition: "Elevated blood pressure in pregnancy",
    conditionPattern: /pregnan.*(?:blood pressure|bp|hypertension|pre-?eclampsia)|(?:blood pressure|bp|hypertension|pre-?eclampsia).*pregnan/,
    match: (f) => f.pregnant === true && (f.gestationWeeks !== null || Boolean(f.gestation20)) && Boolean(f.mildHypertension || f.severeHypertension),
    missing: (f) => missingFacts(f, [["gestation weeks", f.gestationWeeks !== null || Boolean(f.gestation20)], ["blood pressure", Boolean(f.mildHypertension || f.severeHypertension)], ["target-organ symptoms present or absent", /target organ|severe headache|blurred vision|epigastric pain|oliguria|liver tenderness|no target|no severe headache|no blurred/.test(f.text)]]),
    diagnosis: "Pregnancy hypertension branch depends on gestation and target-organ damage.",
    disposition: "admit_or_observe",
    severity: "urgent",
    tests: ["CBC", "Urinalysis", "Renal function", "Liver function", "Coagulation profile when severe"],
    management: "More than 20 weeks with target-organ damage: admit immediately, urgent gynaecology review, left lateral position, IV hydralazine 5 mg slowly over 10 minutes if BP exceeds 160/110, magnesium sulphate loading 4 g of 20% over 15 minutes then 1 g hourly, restrict fluids to 80 mL/hour Ringer lactate. Without target-organ damage: oral methyldopa 250 mg three times daily and admission for observation. Less than 20 weeks follows chronic hypertension pathways.",
    source: "3.1-3.4",
  },
  {
    id: "head_severe",
    condition: "Head injury",
    conditionPattern: /head injury|head injuries|head trauma|traumatic brain|gcs|injury.*head/,
    match: (f) => f.gcs !== null && f.gcs < 8,
    missing: headInjuryMissing,
    diagnosis: "Severe head injury.",
    disposition: "admit_high_level_care",
    severity: "critical",
    tests: ["Urgent CT head"],
    management: "Immediate high-level care, admission, surgical review, urgent CT head. Give ceftriaxone, paracetamol, phenytoin, and tetanus toxoid as in section 4.1.",
    source: "4.3",
  },
  {
    id: "head_moderate",
    condition: "Head injury",
    conditionPattern: /head injury|head injuries|head trauma|traumatic brain|gcs|injury.*head/,
    match: (f) => f.gcs !== null && f.gcs >= 8 && f.gcs <= 12,
    missing: headInjuryMissing,
    diagnosis: "Moderate head injury.",
    disposition: "admit",
    severity: "critical",
    tests: ["Urgent CT head"],
    management: "Immediate admission, urgent CT head, and surgical review. Give ceftriaxone, paracetamol, phenytoin, and tetanus toxoid as in section 4.1.",
    source: "4.2",
  },
  {
    id: "head_mild_features",
    condition: "Head injury",
    conditionPattern: /head injury|head injuries|head trauma|traumatic brain|gcs|injury.*head/,
    match: (f) => f.gcs !== null && f.gcs >= 13 && f.associatedHeadFeatures === true,
    missing: headInjuryMissing,
    diagnosis: "Mild head injury with associated high-risk features.",
    disposition: "admit",
    severity: "urgent",
    tests: ["Urgent CT head"],
    management: "Admit for observation and urgent surgical consult. Give IV ceftriaxone 100 mg/kg per dose, paracetamol 10 mg/kg per dose, phenytoin 20 mg/kg over 15 minutes with ECG and BP monitoring, and tetanus toxoid 0.5 mg IM for patients over 5 years old.",
    source: "4.1",
  },
  {
    id: "head_gcs_13_no_features",
    condition: "Head injury",
    conditionPattern: /head injury|head injuries|head trauma|traumatic brain|gcs|injury.*head/,
    match: (f) => f.gcs !== null && f.gcs >= 13 && f.associatedHeadFeatures === false,
    missing: headInjuryMissing,
    diagnosis: "No terminal head-injury pathway is specified in the internal guideline for GCS 13 or above without associated features.",
    disposition: "not specified in guideline",
    severity: "routine",
    tests: [],
    management: "The internal guideline section 4.1 requires associated features to classify mild head injury requiring admission. If associated features are absent, verify local head-injury observation/discharge policy with a qualified clinician.",
    source: "4.1",
  },
  {
    id: "abdominal_injury",
    condition: "Abdominal injury",
    conditionPattern: /abdominal injury|abdominal trauma|penetrating abdomen|blunt abdomen/,
    match: (f) => conditionMentioned(f, /abdominal injury|abdominal trauma|penetrating abdomen|blunt abdomen/) && f.shock !== undefined,
    missing: (f) => missingFacts(f, [["shock status", f.shock !== undefined]]),
    diagnosis: "Abdominal injury, blunt or penetrating.",
    disposition: "admit",
    severity: "critical",
    tests: ["FAST ultrasound", "CBC", "Renal function", "Liver function", "Grouping and cross-match"],
    management: "If shock is present: immediate resuscitation and urgent surgical consult; do not remove impaled objects; pack wound if no impaled object; perform FAST during resuscitation; give IV ceftriaxone 50 mg/kg, IV metronidazole 7.5 mg/kg, paracetamol 10 mg/kg, and tetanus toxoid for penetrating injuries in patients over 5 years. If stable: admit for observation with maintenance IV fluids and the same workup/antibiotics.",
    source: "5.1-5.2",
  },
  {
    id: "chest_trauma",
    condition: "Chest trauma",
    conditionPattern: /chest trauma|chest injury|thoracic trauma|pneumothorax|haemothorax|hemothorax/,
    match: (f) => conditionMentioned(f, /chest trauma|chest injury|thoracic trauma|pneumothorax|haemothorax|hemothorax/) && (f.shock === false || (f.shock === true && Boolean(f.percussion))),
    missing: (f) => f.shock === undefined ? ["shock status"] : f.shock === true && !f.percussion ? ["percussion note: normal, hyper-resonant, or dull"] : [],
    diagnosis: "Chest trauma pathway.",
    disposition: "admit_or_observe",
    severity: "critical",
    tests: ["Chest x-ray"],
    management: "Shock with normal percussion: resuscitation, oxygen, chest x-ray, urgent specialist consultation, ceftriaxone, metronidazole, and paracetamol. Shock with hyper-resonant note: tension pneumothorax; immediate needle decompression at the 2nd intercostal space mid-clavicular line before imaging. Shock with dull note: possible haemothorax requiring resuscitation, oxygen, urgent surgical review, chest x-ray, and possible chest tube. No shock: reassurance, maintenance IV fluids, admission for observation, chest x-ray, antibiotics/analgesia, and specialist consultation.",
    source: "6.1-6.4",
  },
  {
    id: "epigastric_pain",
    condition: "Epigastric pain",
    conditionPattern: /epigastric|upper abdominal|gastritis|peptic|h\.?\s*pylori|bloody vomit|haematemesis|hematemesis/,
    match: (f) =>
      conditionMentioned(f, /epigastric|upper abdominal|gastritis|peptic|h\.?\s*pylori|bloody vomit|haematemesis|hematemesis/) &&
      f.shock !== undefined &&
      (f.vomiting !== undefined || f.bloodyVomitus !== undefined || Boolean(f.hPylori)),
    missing: (f) => missingFacts(f, [["shock status", f.shock !== undefined], ["vomiting/bloody vomitus status", f.vomiting !== undefined || f.bloodyVomitus !== undefined], ["H. pylori result for stable mild pain", f.shock === true || f.bloodyVomitus === true || f.vomiting === true || Boolean(f.hPylori)]]),
    diagnosis: "Epigastric pain pathway.",
    disposition: "depends_on_branch",
    severity: "urgent",
    tests: ["Full blood count", "Renal function", "Liver function", "H. pylori antigen"],
    management: "Bloody vomitus with shock: resuscitate for presumed upper GI bleeding, admit and urgent surgical consultation, IV fluids, IV clarithromycin, IV Augmentin, IV ranitidine for patients over 16 years, and IV tranexamic acid. Bloody vomitus without shock: admit for endoscopy and surgical review with same medicines and IV normal saline. Non-bloody vomiting with shock: admit, IV fluids, surgical consultation, clarithromycin, Augmentin, ranitidine; omit tranexamic acid if no bleeding. Stable mild pain without vomiting/shock: outpatient PPI if H. pylori negative; eradication kit if positive.",
    source: "7.1-7.4",
  },
  {
    id: "asthma",
    condition: "Wheeze and difficulty breathing",
    conditionPattern: /asthma|wheeze|wheez|pulsus|paradoxus|silent chest|bronchospasm/,
    match: (f) => Boolean(asthmaSeverity(f)),
    missing: (f) => asthmaSeverity(f) ? [] : ["asthma severity features: mental state, ability to talk, accessory muscle use, wheeze pattern, pulse rate, pulsus paradoxus, respiratory failure signs"],
    diagnosis: "Asthmatic attack severity branch.",
    disposition: "depends_on_severity",
    severity: "critical",
    tests: ["Blood gas analysis for severe attack"],
    management: "Mild: outpatient nebulised salbutamol and oral prednisolone 1 mg/kg daily for 7 days, follow up in 24 hours. Moderate: admit for repeated nebulised salbutamol, IV ipratropium 200 micrograms, IV hydrocortisone, call physician. Severe: admit for intensive nebulised salbutamol, IV ipratropium, IV hydrocortisone, blood gas, call physician. Respiratory failure: critical care for possible intubation, aggressive bronchodilator and steroid therapy, call physician immediately.",
    source: "8.1-8.4",
  },
  {
    id: "burns",
    condition: "Burns",
    conditionPattern: /burn|scald|tbsa|thermal|chemical|electrical|full thickness|partial thickness/,
    match: (f) => Boolean(burnBand(f)),
    missing: (f) =>
      burnBand(f)
        ? []
        : missingFacts(f, [
            ["age", f.ageYears !== null || f.burnDepth === "full"],
            ["burn depth", Boolean(f.burnDepth)],
            ["TBSA percent", f.tbsa !== null],
            ["special-area involvement", f.specialAreaBurn !== undefined || f.burnHighRisk],
          ]),
    diagnosis: "Burn injury severity branch.",
    disposition: "depends_on_severity",
    severity: "urgent",
    tests: ["Coagulation profile and liver function tests for severe burns"],
    management: "Mild: outpatient oral flucloxacillin 50 mg/kg, paracetamol 10 mg/kg, topical silver sulfadiazine, cleanse with 0.25% chlorhexidine, follow up in 3 days. Moderate: admit for surgical review, IV flucloxacillin 50 mg/kg, IV metronidazole 7.5 mg/kg, IM pethidine 50 mg, topical silver sulfadiazine, tetracycline eye ointment for facial burns, omeprazole 4 mg/kg, fluid protocols. Severe: specialised burns unit/ICU, aggressive fluids, IV flucloxacillin/metronidazole, blood product support, coagulation/liver monitoring, surgical review.",
    source: "9.1-9.3",
  },
  {
    id: "hyperkalaemia",
    condition: "Hyperkalaemia",
    conditionPattern: /hyperkalaemia|hyperkalemia|potassium|high k\+|k\+/,
    match: (f) => f.potassium !== null || f.potassiumStatus === "high" || /potassium.*above normal|above normal.*potassium|high potassium|hyperkalaemia|hyperkalemia/.test(f.text),
    missing: (f) => missingFacts(f, [["serum potassium above normal or numeric level", f.potassium !== null || f.potassiumStatus === "high" || /above normal|high potassium|hyperkalaemia|hyperkalemia/.test(f.text)]]),
    diagnosis: "Confirmed hyperkalaemia management.",
    disposition: "depends_on_response",
    severity: "critical",
    tests: ["Electrolytes", "ECG"],
    management: "Stop potassium intake. Give sodium/calcium polystyrene sulphonate 0.5-1 g/kg orally or high enema. Give 10% calcium gluconate 0.5-1 mg/kg IV over 5-10 minutes. Shift potassium with 4% sodium bicarbonate 1-2 mL/kg IV over 5-10 minutes, 50% dextrose 1-2 mL/kg IV over 15-30 minutes with soluble insulin 1 unit per 5 g dextrose if used, and nebulised salbutamol 2.5 mg over 20 minutes. Dialysis if ineffective.",
    source: "10",
  },
  {
    id: "dka",
    condition: "Diabetic ketoacidosis",
    conditionPattern: /diabetic ketoacidosis|\bdka\b|ketone|kussmaul|polyuria|polydipsia/,
    match: (f) => conditionMentioned(f, /diabetic ketoacidosis|\bdka\b|ketone|kussmaul|polyuria|polydipsia/) || f.glucoseStatus === "high" || (f.glucose !== null && f.glucose > 11),
    missing: (f) => missingFacts(f, [["blood glucose", f.glucose !== null || Boolean(f.glucoseStatus) || /blood sugar|glucose/.test(f.text)], ["ketones", /ketone/.test(f.text)], ["pH or bicarbonate", f.ph !== null || f.bicarbonate !== null], ["dehydration status", Boolean(f.dehydration)]]),
    diagnosis: "Diabetic ketoacidosis management pathway.",
    disposition: "admit",
    severity: "critical",
    tests: ["Random blood sugar", "Urine ketones", "Blood gas/pH", "Serum bicarbonate", "Electrolytes", "ECG"],
    management: "Assess dehydration and calculate deficit plus maintenance over 48 hours. If reduced pulses, reduced consciousness, or coma: secure airway, give 100% oxygen, 0.9% saline 10 mL/kg over 10-30 minutes, repeat if needed. Use 0.9% saline for correction. Give potassium chloride 20-30 mmol/hour after first 30-60 minutes if potassium is normal/low; delay if high. Start insulin 0.1 IU/kg/hour, or 0.05 IU/kg/hour in younger children. When glucose reaches 15 mmol/L or falls by >5 mmol/hour, change to 0.45% saline with 5% dextrose and adjust insulin to 0.05 IU/kg/hour. Monitor neuro status hourly and electrolytes every 2 hours.",
    source: "12",
  },
  {
    id: "paediatric_fluids",
    condition: "Fluid management in neonates and children",
    conditionPattern: /dehydration|diarrhoea|diarrhea|ors|plan a|plan b|plan c|neonate fluid|newborn fluid/,
    match: (f) => conditionMentioned(f, /dehydration|diarrhoea|diarrhea|ors|plan a|plan b|plan c|neonate|newborn/),
    missing: (f) => missingFacts(f, [["dehydration status", Boolean(f.dehydration) || /neonate|newborn/.test(f.text)], ["age group", f.ageMonths !== null || f.ageDays !== null || /neonate|newborn|child/.test(f.text)]]),
    diagnosis: "Paediatric/neonatal fluid management pathway.",
    disposition: "depends_on_dehydration",
    severity: "urgent",
    tests: [],
    management: "Neonates: day 1 60 mL/kg/day, day 2 90 mL/kg/day, day 3 120 mL/kg/day, then increase by 30 mL/kg/day and encourage breastfeeding. Plan A: ORS after loose motions and zinc. Plan B: ORS 75 mL/kg over 4 hours, reassess, zinc. Plan C: Ringer lactate 100 mL/kg; under 12 months 30 mL/kg first 1 hour then 70 mL/kg over 5 hours; over 12 months 30 mL/kg first 30 minutes then 70 mL/kg over 150 minutes.",
    source: "13",
  },
  {
    id: "hypernatraemia",
    condition: "Hypernatraemia",
    conditionPattern: /hypernatraemia|hypernatremia|high sodium|sodium.*(?:above|high|raised|elevated)/,
    match: (f) => (f.sodium !== null && f.sodium > 150) || f.sodiumStatus === "high" || /sodium.*above 150|hypernatraemia|hypernatremia|high sodium/.test(f.text),
    missing: (f) => missingFacts(f, [["serum sodium", f.sodium !== null || f.sodiumStatus === "high" || /above 150|high sodium|hypernatraemia|hypernatremia/.test(f.text)]]),
    diagnosis: "Hypernatraemia treatment.",
    disposition: "admit_monitor",
    severity: "critical",
    tests: ["Serial electrolytes every 4 hours", "Hourly weight"],
    management: "Use hypotonic solutions. Give half-strength Darrow solution at 0.5-1.0 mmol/hour over 24 hours. Check sodium every 4 hours until below 150 mmol/L and weigh hourly. Adjust infusion depending on sodium fall and weight change.",
    source: "14",
  },
  {
    id: "hyponatraemia",
    condition: "Hyponatraemia",
    conditionPattern: /hyponatraemia|hyponatremia|low sodium|sodium.*(?:below|low)/,
    match: (f) => (f.sodium !== null && f.sodium < 130) || f.sodiumStatus === "low" || /sodium.*below 130|hyponatraemia|hyponatremia|low sodium/.test(f.text),
    missing: (f) => missingFacts(f, [["serum sodium", f.sodium !== null || f.sodiumStatus === "low" || /below 130|low sodium|hyponatraemia|hyponatremia/.test(f.text)], ["neurological emergency signs", /seizure|coma|cerebral herniation|no seizure|no coma/.test(f.text)], ["volume status", Boolean(f.volumeStatus)]]),
    diagnosis: "Hyponatraemia emergency and volume-status management.",
    disposition: "admit_monitor",
    severity: "critical",
    tests: ["Electrolytes", "Volume status assessment"],
    management: "If seizure, coma, or suspected cerebral herniation: give IV 3% hypertonic saline 100-150 mL over 5-10 minutes, reassess, repeat once if no improvement, then stop fluids. If unavailable, give one ampoule sodium bicarbonate over 5 minutes. Assess volume status. Hypovolaemic: restore circulating volume with Ringer lactate. Euvolemic: restrict free fluids to less than 1 L/day. Hypervolemic: treat underlying cause, consider fluid restriction and diuretics.",
    source: "15",
  },
  {
    id: "pph_risk",
    condition: "Postpartum haemorrhage risk",
    conditionPattern: /postpartum haemorrhage|postpartum hemorrhage|\bpph\b|postpartum.*bleed|caesarean blood loss|cesarean blood loss/,
    match: (f) => conditionMentioned(f, /postpartum haemorrhage|postpartum hemorrhage|\bpph\b|postpartum.*bleed/) || (f.bloodLossMl !== null && f.bloodLossMl > 500),
    missing: (f) => missingFacts(f, [["estimated blood loss", f.bloodLossMl !== null || /active bleeding|postpartum haemorrhage|postpartum hemorrhage|\bpph\b/.test(f.text)], ["risk factors", /placenta|coagulopathy|platelet|caesarean|cesarean|myomectomy|multiple gestation|chorioamnionitis|oxytocin|bmi|haematocrit|myoma|prior births/.test(f.text)]]),
    diagnosis: "Postpartum haemorrhage risk assessment and immediate response.",
    disposition: "prepare_or_resuscitate",
    severity: "critical",
    tests: ["Complete blood count", "Renal function tests", "Grouping and cross-match"],
    management: "High-risk factors require increased vigilance and preparation. For postpartum haemorrhage, defined as vaginal bleeding over 500 mL or caesarean blood loss over 1000 mL, initiate immediate resuscitation, CBC, renal function tests, and grouping/cross-match.",
    source: "Appendix",
  },
];

function conditionRules(facts: ClinicalFacts) {
  return rules.filter((rule) => rule.conditionPattern.test(facts.text));
}

function formatMissing(rule: DifferentialRule, facts: ClinicalFacts) {
  const missing = rule.missing(facts);
  if (!missing.length) return "";
  const displayMissing = missing.map((fact) => `- ${humanMissingFact(fact)}`).join("\n");
  const source = missingQuestionSource(rule);
  return `I can help classify this using the internal clinical guideline, but I need the key branching detail first.

For ${rule.condition.toLowerCase()}, would you check the following?
${displayMissing}

Once you answer, I will match the correct pathway and include recommended tests, medications, and management.

Source:
Internal clinical guideline, section ${source}`;
}

function humanMissingFact(fact: string) {
  const labels: Record<string, string> = {
    gcs: "Glasgow Coma Scale (GCS) score",
    associated_features:
      "associated features: convulsions, confusion, CSF otorrhoea/rhinorrhoea, penetrating injury, palpable fracture/deformity, blurred vision, vomiting, anisocoria, lateralising signs, age under 5, or age over 60",
    tbsa_percent: "total body surface area (TBSA) percentage",
    shock_status: "whether signs of shock are present",
  };
  return labels[fact] || fact.replace(/_/g, " ");
}

function missingQuestionSource(rule: DifferentialRule) {
  if (rule.condition === "Head injury") return "4.1-4.3";
  if (rule.condition === "Burns") return "9.1-9.3";
  if (rule.condition === "Wheeze and difficulty breathing") return "8.1-8.4";
  if (rule.condition === "Per vaginal bleeding") return "1.1-1.4";
  if (rule.condition === "Hotness of body") return "2.1-2.6";
  return rule.source;
}

function formatRule(rule: DifferentialRule, facts: ClinicalFacts) {
  const band = rule.id === "burns" ? burnBand(facts) : null;
  const asthma = rule.id === "asthma" ? asthmaSeverity(facts) : null;
  const branch = branchSpecific(rule, band, asthma, facts);
  const tests = branch.tests?.length ? `\n\nRecommended diagnostic tests:\n${branch.tests.map((test) => `- ${test}`).join("\n")}` : "";
  const qualifier = band ? ` (${band} branch)` : asthma ? ` (${asthma === "failure" ? "respiratory failure" : asthma} branch)` : "";
  const source =
    band === "mild"
      ? "9.1"
      : band === "moderate"
        ? "9.2"
        : band === "severe"
          ? "9.3"
          : asthma === "mild"
            ? "8.1"
            : asthma === "moderate"
              ? "8.2"
              : asthma === "severe"
                ? "8.3"
                : asthma === "failure"
                  ? "8.4"
                  : rule.source;

  return `Urgency: ${rule.severity === "critical" ? "Critical" : rule.severity === "urgent" ? "Urgent" : "Routine"}.

What this means:
${branch.diagnosis || rule.diagnosis}${qualifier}

Recommended disposition:
${branch.disposition || rule.disposition}${tests}

Management and medication guidance:
${branch.management || rule.management}

Source:
Internal clinical guideline, section ${source}`;
}

function branchSpecific(rule: DifferentialRule, band: string | null, asthma: string | null, facts: ClinicalFacts) {
  if (rule.id === "burns") {
    if (band === "mild") {
      return {
        diagnosis: "Mild burn injury.",
        disposition: "outpatient",
        tests: [] as string[],
        management:
          "Outpatient oral flucloxacillin 50 mg/kg per dose, paracetamol 10 mg/kg per dose, and topical silver sulfadiazine. Cleanse with 0.25% chlorhexidine and apply clean wraps. Follow up in 3 days.",
      };
    }
    if (band === "moderate") {
      return {
        diagnosis: "Moderate burn injury requiring admission.",
        disposition: "admit",
        tests: [] as string[],
        management:
          "Admit for surgical review. Give IV flucloxacillin 50 mg/kg per dose, IV metronidazole 7.5 mg/kg, IM pethidine 50 mg for pain, and topical silver sulfadiazine. For facial burns, add tetracycline eye ointment. Give omeprazole 4 mg/kg per dose for gastrointestinal protection. Follow fluid management protocols.",
      };
    }
    if (band === "severe") {
      return {
        diagnosis: "Severe burn injury requiring specialised burns unit or intensive care.",
        disposition: "specialised_unit",
        tests: ["Coagulation profile", "Liver function tests"],
        management:
          "Requires aggressive fluid resuscitation, IV flucloxacillin and metronidazole, blood product support, coagulation profile monitoring, liver function tests, and surgical review.",
      };
    }
  }

  if (rule.id === "asthma") {
    if (asthma === "mild") {
      return {
        diagnosis: "Mild asthmatic attack.",
        disposition: "outpatient",
        tests: [] as string[],
        management:
          "Outpatient nebulised salbutamol: 1 month to 11 years 2.5 mg; over 11 years 5 mg, repeated up to 3 doses in the first hour. Add oral prednisolone 1 mg/kg daily for 7 days. Follow up in 24 hours.",
      };
    }
    if (asthma === "moderate") {
      return {
        diagnosis: "Moderate asthmatic attack.",
        disposition: "admit",
        tests: [] as string[],
        management:
          "Admit for repeated nebulised salbutamol, IV ipratropium 200 micrograms, and IV hydrocortisone: 1-5 years 50 mg; 6-12 years 100 mg. Call a physician immediately.",
      };
    }
    if (asthma === "severe") {
      return {
        diagnosis: "Severe asthmatic attack.",
        disposition: "admit",
        tests: ["Blood gas analysis"],
        management:
          "Admit for intensive nebulised salbutamol, IV ipratropium, and IV hydrocortisone. Obtain blood gas analysis. Call a physician immediately.",
      };
    }
    if (asthma === "failure") {
      return {
        diagnosis: "Impending or actual respiratory failure in asthma.",
        disposition: "critical_care",
        tests: [] as string[],
        management:
          "Admit to a critical care area for possible intubation. Intubate if necessary. Administer aggressive bronchodilator and steroid therapy. Call a physician immediately.",
      };
    }
  }

  if (rule.id === "epigastric_pain") {
    if (facts.bloodyVomitus === true && facts.shock === true) {
      return {
        diagnosis: "Presumed upper gastrointestinal bleeding with shock.",
        disposition: "admit",
        tests: ["Full blood count", "Renal function", "Liver function", "H. pylori antigen"],
        management:
          "Immediate resuscitation. Send FBC, renal and liver function tests, and H. pylori antigen. Admit for urgent surgical consultation. Start IV fluids according to hypovolaemic shock protocol. Give IV clarithromycin, IV Augmentin, IV ranitidine for patients over 16 years, and IV tranexamic acid 10 mg/kg per dose three times daily. Manage anaemia, thrombocytopenia, and deranged liver or renal function concurrently.",
      };
    }
    if (facts.bloodyVomitus === true && facts.shock === false) {
      return {
        diagnosis: "Upper gastrointestinal bleeding without shock.",
        disposition: "admit",
        tests: ["Full blood count", "Renal function", "Liver function", "H. pylori antigen"],
        management:
          "Start IV normal saline while awaiting consultation. Admit for endoscopy and surgical review. Give clarithromycin, Augmentin, ranitidine, and tranexamic acid as in the bloody-vomitus pathway.",
      };
    }
    if (facts.vomiting === true && facts.bloodyVomitus !== true && facts.shock === true) {
      return {
        diagnosis: "Severe gastritis or peptic ulcer disease with shock.",
        disposition: "admit",
        tests: ["Full blood count", "Renal function", "Liver function", "H. pylori antigen"],
        management:
          "Admit, resuscitate with IV fluids, and request surgical consultation. Give clarithromycin, Augmentin, and ranitidine. Tranexamic acid may be omitted if there is no bleeding.",
      };
    }
    if (facts.vomiting === false && facts.shock === false && facts.hPylori === "negative") {
      return {
        diagnosis: "Stable mild epigastric pain with negative H. pylori.",
        disposition: "outpatient",
        tests: ["H. pylori antigen"],
        management:
          "Outpatient proton pump inhibitor such as esomeprazole. Over 12 years: 20 mg twice daily. Paediatric dosing by weight: 3.5 kg, 2.5 mg daily; 3.5-7.5 kg, 5 mg daily; over 7.5 kg, 10 mg daily. Follow up in 7 days.",
      };
    }
    if (facts.vomiting === false && facts.shock === false && facts.hPylori === "positive") {
      return {
        diagnosis: "Stable mild epigastric pain with positive H. pylori.",
        disposition: "outpatient",
        tests: ["H. pylori antigen"],
        management:
          "Outpatient H. pylori eradication kit with esomeprazole, amoxicillin, and clarithromycin plus paracetamol. Follow up in 7 days.",
      };
    }
  }

  return {
    diagnosis: rule.diagnosis,
    disposition: rule.disposition,
    tests: rule.tests,
    management: rule.management,
  };
}

export function buildDifferentialDiagnosisAnswer(input: string) {
  const facts = extractClinicalFacts(input);
  const candidates = conditionRules(facts);
  if (!candidates.length) return null;

  const matched = candidates.find((rule) => rule.missing(facts).length === 0 && rule.match(facts));
  if (matched) return formatRule(matched, facts);

  const mostRelevant = candidates.find((rule) => rule.missing(facts).length > 0) || candidates[0];
  return formatMissing(mostRelevant, facts);
}
