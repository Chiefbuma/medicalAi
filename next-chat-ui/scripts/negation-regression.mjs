const cases = [
  "denies vomiting",
  "no evidence of vomiting",
  "vomiting resolved",
  "vomiting absent",
  "negative for vomiting",
  "vomiting ruled out",
  "patient without vomiting",
  "vomiting not observed",
  "no vomiting",
  "not vomiting",
  "patient denied vomiting",
  "vomiting has stopped",
  "not absent vomiting",
  "probably not vomiting",
];

function patternSource(pattern) {
  return pattern.source.replace(/^\^|\$$/g, "");
}

function textWindow(concept, before, after, words = 8) {
  const c = patternSource(concept);
  return new RegExp(`${before}(?:\\W+\\w+){0,${words}}\\W+(?:${c})|(?:${c})(?:\\W+\\w+){0,${words}}\\W+${after}`);
}

function negatesConcept(text, concept, explicitNegative) {
  const normalized = text.toLowerCase();
  const c = patternSource(concept);
  const highBefore =
    "\\b(?:no|not|without|denies?|denied|absence of|absent|free of|negative for|no evidence of|ruled out|nil|none)\\b";
  const highAfter = "\\b(?:absent|negative|resolved|stopped|settled|subsided|not present|has stopped|has resolved|ruled out|not observed)\\b";
  const mediumBefore = "\\b(?:likely no|likely not|probably no|probably not|unlikely|less likely|doubtful for)\\b";
  const mediumAfter = "\\b(?:less likely|unlikely|doubtful)\\b";
  const doubleNegation = new RegExp(
    `\\b(?:not|no longer)\\s+(?:absent|negative|ruled out|resolved|stopped)\\b(?:\\W+\\w+){0,8}\\W+(?:${c})|(?:${c})(?:\\W+\\w+){0,8}\\W+\\b(?:not|no longer)\\s+(?:absent|negative|ruled out|resolved|stopped)\\b`,
  );

  if (doubleNegation.test(normalized)) return { status: "present", negationCertainty: null };
  if (textWindow(concept, mediumBefore, mediumAfter).test(normalized)) {
    return { status: "absent", negationCertainty: "medium" };
  }
  if (explicitNegative?.test(normalized) || textWindow(concept, highBefore, highAfter).test(normalized)) {
    return { status: "absent", negationCertainty: "high" };
  }
  if (concept.test(normalized)) return { status: "present", negationCertainty: null };
  return { status: "unknown", negationCertainty: null };
}

let failures = 0;
for (const input of cases) {
  const result = negatesConcept(input, /vomit\w*|emesis/, /no vomit\w*|not vomit\w*|denies vomit\w*|denied vomit\w*/);
  const shouldBePresent = /not absent/.test(input);
  const shouldBeMedium = /probably not/.test(input);
  const passed = shouldBePresent
    ? result.status === "present"
    : shouldBeMedium
      ? result.status === "absent" && result.negationCertainty === "medium"
      : result.status !== "present";
  if (!passed) failures += 1;
  console.log(`${passed ? "PASS" : "FAIL"} ${JSON.stringify(input)} -> ${JSON.stringify(result)}`);
}

if (failures) {
  process.exitCode = 1;
}
