import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Document } from "@langchain/core/documents";
import { RAG_CONFIG } from "./config";

const DEFAULT_SCAN_DIRS = ["extracted-images", "rag-files/pending", "rag-files/processed"];
const CHUNK_SIZE = 1_200;
const CHUNK_OVERLAP = 180;

type ClinicalChunkMetadata = {
  source: string;
  sourceName: string;
  chunkIndex: number;
  sectionNumber?: string;
  chunkType: "assessment" | "decision" | "treatment" | "danger";
  keywords: string[];
  medications: string[];
  dangerSigns: string[];
};

const MEDICATIONS = [
  "paracetamol",
  "tranexamic acid",
  "ceftriaxone",
  "metronidazole",
  "salbutamol",
  "prednisolone",
  "hydrocortisone",
  "flucloxacillin",
  "pethidine",
  "omeprazole",
  "mannitol",
  "insulin",
  "artesunate",
  "methyldopa",
  "methylodopa",
  "magnesium sulphate",
  "phenytoin",
];

const DANGER_SIGNS = [
  "signs of shock",
  "altered consciousness",
  "severe pain",
  "active bleeding",
  "seizure",
  "respiratory distress",
  "cannot drink",
  "convulsions",
  "unconscious",
  "airway compromise",
];

const KEYWORDS = [
  "shock",
  "bleeding",
  "fever",
  "hypertension",
  "diabetic",
  "asthma",
  "burn",
  "trauma",
  "pregnancy",
  "sepsis",
  "malaria",
];

function normalizeText(text: string) {
  return text.replace(/\r/g, "\n").replace(/\f/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function makeChunkId(source: string, chunkIndex: number, content: string) {
  const hash = createHash("sha256").update(`${source}:${chunkIndex}:${content}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function extractTerms(content: string, terms: string[]) {
  const lower = content.toLowerCase();
  return terms.filter((term) => lower.includes(term));
}

function classifyChunk(content: string): ClinicalChunkMetadata["chunkType"] {
  const lower = content.toLowerCase();
  if (DANGER_SIGNS.some((sign) => lower.includes(sign)) || /danger|emergency|urgent|red flag/.test(lower)) {
    return "danger";
  }
  if (/administer|prescribe|dose|mg\/kg|tablet|injection|treat/.test(lower)) return "treatment";
  if (/\bif\b.+\bthen\b|\bwhen\b.+\brefer\b/i.test(content)) return "decision";
  return "assessment";
}

function extractSectionNumber(content: string) {
  return content.match(/(?:^|\n)\s*(\d+(?:\.\d+){0,3})\s+[A-Z]/)?.[1] || inferSectionNumber(content);
}

function inferSectionNumber(content: string) {
  const lower = content.toLowerCase();
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

function splitText(text: string) {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: Array<{ content: string; sectionNumber?: string }> = [];
  let current = "";
  let currentChunkSectionNumber: string | undefined;
  let activeSectionNumber: string | undefined;

  for (const paragraph of paragraphs) {
    const paragraphSectionNumber = extractSectionNumber(paragraph);
    if (paragraphSectionNumber && current) {
      chunks.push({ content: current, sectionNumber: currentChunkSectionNumber || activeSectionNumber });
      current = "";
      currentChunkSectionNumber = undefined;
    }

    if (paragraphSectionNumber) activeSectionNumber = paragraphSectionNumber;
    const sectionNumber = paragraphSectionNumber || activeSectionNumber;

    if ((current + "\n\n" + paragraph).trim().length <= CHUNK_SIZE) {
      if (!current) currentChunkSectionNumber = sectionNumber;
      current = [current, paragraph].filter(Boolean).join("\n\n");
      continue;
    }

    if (current) chunks.push({ content: current, sectionNumber: currentChunkSectionNumber || activeSectionNumber });

    if (paragraph.length <= CHUNK_SIZE) {
      current = paragraph;
      currentChunkSectionNumber = sectionNumber;
      continue;
    }

    for (let start = 0; start < paragraph.length; start += CHUNK_SIZE - CHUNK_OVERLAP) {
      const content = paragraph.slice(start, start + CHUNK_SIZE).trim();
      chunks.push({ content, sectionNumber: extractSectionNumber(content) || sectionNumber });
    }
    current = "";
    currentChunkSectionNumber = undefined;
  }

  if (current) chunks.push({ content: current, sectionNumber: currentChunkSectionNumber || activeSectionNumber });
  return chunks.filter((chunk) => chunk.content.length > 80);
}

function toAllowedPath(candidate: string) {
  const root = path.resolve(RAG_CONFIG.sharedDataRoot);
  const resolved = path.resolve(path.isAbsolute(candidate) ? candidate : path.join(root, candidate));

  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path is outside shared data root: ${candidate}`);
  }

  return resolved;
}

async function collectPdfPaths(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const paths = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) return collectPdfPaths(fullPath);
        return entry.isFile() && entry.name.toLowerCase().endsWith(".pdf") ? [fullPath] : [];
      }),
    );
    return paths.flat();
  } catch {
    return [];
  }
}

export async function getDefaultPdfPaths() {
  const roots = DEFAULT_SCAN_DIRS.map((dir) => path.join(RAG_CONFIG.sharedDataRoot, dir));
  const paths = await Promise.all(roots.map((dir) => collectPdfPaths(dir)));
  return paths.flat().sort();
}

export async function resolvePdfPaths(paths?: string[]) {
  const resolved = paths?.length ? paths.map(toAllowedPath) : await getDefaultPdfPaths();
  const checked = await Promise.all(
    resolved.map(async (filePath) => {
      const info = await stat(filePath);
      if (!info.isFile() || !filePath.toLowerCase().endsWith(".pdf")) return null;
      return filePath;
    }),
  );
  return checked.filter((filePath): filePath is string => Boolean(filePath));
}

export async function processPdf(filePath: string) {
  const textSidecarPath = filePath.replace(/\.pdf$/i, ".txt");

  try {
    let rawText: string;
    try {
      rawText = await readFile(textSidecarPath, "utf8");
    } catch {
      const { PDFParse } = await import("pdf-parse");
      const buffer = await readFile(filePath);
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        rawText = result.text;
      } finally {
        await parser.destroy();
      }
    }

    const text = normalizeText(rawText);
    const relativeSource = path.relative(RAG_CONFIG.sharedDataRoot, filePath);
    const chunks = splitText(text);

    return chunks.map((chunk, chunkIndex) => {
      const metadata: ClinicalChunkMetadata = {
        source: relativeSource,
        sourceName: path.basename(filePath),
        chunkIndex,
        sectionNumber: chunk.sectionNumber,
        chunkType: classifyChunk(chunk.content),
        keywords: extractTerms(chunk.content, KEYWORDS),
        medications: extractTerms(chunk.content, MEDICATIONS),
        dangerSigns: extractTerms(chunk.content, DANGER_SIGNS),
      };

      return new Document({
        pageContent: chunk.content,
        metadata: {
          ...metadata,
          id: makeChunkId(relativeSource, chunkIndex, chunk.content),
        },
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown PDF processing error";
    throw new Error(`Unable to process ${filePath}. Add a text sidecar at ${textSidecarPath} or install PDF runtime dependencies. ${message}`);
  }
}

export async function processClinicalGuidelines(paths?: string[]) {
  const pdfPaths = await resolvePdfPaths(paths);
  const documentsByFile = await Promise.all(pdfPaths.map((filePath) => processPdf(filePath)));
  return {
    pdfPaths,
    documents: documentsByFile.flat(),
  };
}
