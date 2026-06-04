export type ChatIntent =
  | { type: "direct"; response: string }
  | { type: "repeat"; focus?: "management" | "tests" | "source" | "all" }
  | { type: "completeness" }
  | { type: "confirmation" }
  | { type: "clarification"; term?: string }
  | { type: "rationale"; fact?: string }
  | { type: "definition"; term?: string }
  | { type: "external_gap" }
  | { type: "disposition_question"; target: "admission" | "disposition" }
  | {
      type: "focused_question";
      target: "medication" | "tests" | "management" | "diagnosis" | "surgery" | "referral" | "source";
      mode: "yes_no" | "extract";
    }
  | { type: "unclear"; reason: "control" | "too_short" | "incoherent" }
  | { type: "clinical"; isFollowUp: boolean; wantsDiagnostics: boolean; wantsManagement: boolean };

function normalized(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function routeChatIntent(input: string): ChatIntent {
  const text = normalized(input);
  const hasClinicalSignal =
    /\b(?:patient|child|woman|man|boy|girl|infant|baby|pregnan\w*|gestation\w*|bleed\w*|fever|shock|pneumonia|asthma\w*|wheez\w*|burn\w*|vomit\w*|pain|diarrh\w*|cough\w*|breath\w*|oxygen|spo2|pulse|blood pressure|potassium|sodium|glucose|ketone\w*|dehydrat\w*|convulsion\w*|seizure\w*|haemoglobin|hemoglobin|malaria|cbc|fbc|tbsa|gcs|insulin|fluid\w*|antibiotic\w*|test\w*|diagnostic\w*|manage\w*|treat\w*|dose)\b/.test(
      text,
    ) || /\d/.test(text);

  if (/^(stop|halt|pause|cancel|abort|end|enough|close)\.?$/.test(text)) {
    return { type: "unclear", reason: "control" };
  }

  if (!/[a-z0-9]/.test(text) || /^[^\w]+$/.test(text)) {
    return { type: "unclear", reason: "incoherent" };
  }

  if (/^(repeat|repeat that|say again|again|come again|what did you say)\b/.test(text)) {
    const focus = /\b(management|treat|treatment|medication|drug|dose)\b/.test(text)
      ? "management"
      : /\b(test|tests|investigation|investigations|diagnostic)\b/.test(text)
        ? "tests"
        : /\b(source|citation|section|line)\b/.test(text)
          ? "source"
          : "all";
    return { type: "repeat", focus };
  }

  if (/^(is that all|anything else|anything more|is that everything|that's it|that is it|what else|is there more)\??$/.test(text)) {
    return { type: "completeness" };
  }

  if (/^(yes|correct|that's right|that is right|exactly|ok|okay|got it)\.?$/.test(text)) {
    return { type: "confirmation" };
  }

  if (/^(hi|hello|hey|good morning|good afternoon|good evening)\b/.test(text)) {
    return {
      type: "direct",
      response:
        "Hello. I can help match a patient presentation to the internal clinical guideline. Tell me the main complaint, key vitals, and relevant positives or negatives.",
    };
  }

  if (/^(thanks|thank you|ok thanks|okay thanks|great thanks)\b/.test(text)) {
    return { type: "direct", response: "You are welcome." };
  }

  if (/\b(who are you|what are you)\b/.test(text)) {
    return {
      type: "direct",
      response:
        "I am RadiantMedAI, a clinical guideline assistant for this app. I use the internal clinical guideline and the facts in this chat session to help classify pathways, ask focused follow-up questions, and show guideline-based management.",
    };
  }

  if (/\b(latest|new research|recent evidence|pubmed|uptodate|outside guideline|outside the guideline)\b/.test(text)) {
    return { type: "external_gap" };
  }

  if (
    /\b(which|what)\s+(guideline|guidelines|guidlines|guidlines)\b/.test(text) ||
    /\bwhere.*(?:answer|response|information).*coming from\b/.test(text) ||
    /\bdo you use internet|internet|online source\b/.test(text)
  ) {
    return {
      type: "direct",
      response:
        "RadiantMedAI only uses the internal approved and updated clinical guideline ingested into this app for specific clinical conditions. I do not use the internet for clinical answers. For conditions not covered by this guideline, verify with a qualified clinician.",
    };
  }

  if (/^(what do you mean|explain|explain that|clarify|can you clarify|i don't understand|i do not understand)\b/.test(text)) {
    const term = text.match(/\b(?:by|about)\s+(.+?)(?:\?|$)/)?.[1]?.trim();
    return {
      type: "clarification",
      term,
    };
  }

  if (/^(is that true|is this true|true\??|are you sure)\??$/.test(text)) {
    return {
      type: "direct",
      response:
        "I can verify a statement only against the internal clinical guideline and the facts in this chat. Please tell me the exact diagnosis, test, dose, or disposition you want checked.",
    };
  }

  if (
    /\b(?:does|do|should|is|are|will|would|answer my question|just answer|confirm)\b.*\b(?:admission|admit|admitted|hospitali[sz]e|inpatient)\b/.test(text) ||
    /\b(?:admission|admit|admitted|hospitali[sz]e|inpatient)\b.*\b(?:needed|required|indicated|yes|no)\b/.test(text)
  ) {
    return { type: "disposition_question", target: "admission" };
  }

  if (/\b(?:what|which|repeat|confirm|tell me)\b.*\b(?:disposition|outcome)\b/.test(text)) {
    return { type: "disposition_question", target: "disposition" };
  }

  const yesNoStart = /^(?:does|do|is|are|will|can|could|should|would|need|confirm|verify|answer my question|please answer|just tell me)\b/.test(text);
  const extractionStart = /^(?:what|which|list|show|repeat|just|only|just tell me|tell me)\b/.test(text);
  type FocusedTarget = Extract<ChatIntent, { type: "focused_question" }>["target"];
  const focusedTargets: Array<[FocusedTarget, RegExp]> = [
    ["medication", /\b(?:medication|medicine|drug|antibiotic|dose|dosage|give|administer|prescribe)\b/],
    ["tests", /\b(?:test|tests|investigation|investigations|diagnostic|labs?|cbc|fbc|ultrasound|x-?ray|scan)\b/],
    ["management", /\b(?:management|manage|treatment|treat|therapy|plan)\b/],
    ["diagnosis", /\b(?:diagnosis|diagnoses|condition|what is it|what does the patient have)\b/],
    ["surgery", /\b(?:surgery|surgical|operation|debridement)\b/],
    ["referral", /\b(?:referral|refer|consult|specialist|review)\b/],
    ["source", /\b(?:source|citation|section|line|score)\b/],
  ];

  for (const [target, pattern] of focusedTargets) {
    if (pattern.test(text) && (yesNoStart || extractionStart || /\b(?:needed|required|indicated|recommended)\b/.test(text))) {
      return { type: "focused_question", target, mode: yesNoStart ? "yes_no" : "extract" };
    }
  }

  if (/\b(?:from|on|search)\s+(?:the\s+)?(?:internet|online)\b/.test(text)) {
    return { type: "external_gap" };
  }

  if (/^(what is|what are|define|definition of|explain what)\b/.test(text)) {
    const term =
      text.match(/^(?:what is|what are|define|definition of|explain what)\s+(.+?)(?:\?|$)/)?.[1]?.trim() ||
      undefined;
    return { type: "definition", term };
  }

  if (/^(why|why do you need|why need|why are you asking|why ask|what is the reason)\b/.test(text)) {
    const fact =
      text.match(/\b(age|tbsa|body surface|burn depth|depth|special area|pregnancy|gestation|shock|blood pressure|malaria|cbc|haemoglobin|hemoglobin|potassium|sodium|oxygen|spo2)\b/)?.[1] ||
      undefined;
    return { type: "rationale", fact };
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (!hasClinicalSignal && (wordCount <= 2 || text.length < 12)) {
    return { type: "unclear", reason: "too_short" };
  }

  const wantsDiagnostics = /\b(?:test|tests|investigation|investigations|diagnostic|diagnostics|lab|labs|cbc|fbc|ultrasound|x-?ray|ct|scan|blood gas|urinalysis|cross-?match)\b/.test(
    text,
  );
  const wantsManagement = /\b(?:manage|management|manag|treat|treatment|therapy|medication|medicine|drug|administer|give|dose|fluid|insulin|antibiotic)\b/.test(
    text,
  );
  const isFollowUp =
    /^(what|which|where|why|when|how|any|same patient|same case|continue|and\b|also\b|there is|patient has)\b/.test(text) ||
    wantsDiagnostics ||
    wantsManagement;

  return {
    type: "clinical",
    isFollowUp,
    wantsDiagnostics,
    wantsManagement,
  };
}
