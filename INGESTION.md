Below is the final Docling -> Qdrant clinical guideline ingestion workflow for future reference.

FINAL INGESTION WORKFLOW
Local File Trigger
        ↓
Read/Write Files from Disk
        ↓
HTTP Request to Docling API
        ↓
Code: Extract Markdown/Text
        ↓
Code: Split by Condition + Variant and Add Metadata
        ↓
Code: Add Clinical Keywords / Drugs / Criteria Metadata
        ↓
Code: Chunk Pathway Text
        ↓
Code: Prepare Text For Loader
        ↓
Default Data Loader
        ↓
Qdrant Vector Store
              ↑
        Embeddings Ollama

Purpose: convert a clinical guideline PDF into searchable clinical pathway chunks stored in Qdrant.

1. Local File Trigger
Node
Local File Trigger
Purpose

Watches a folder and starts ingestion when a new PDF is added.

Settings
Trigger On:
Changes Involving a Specific Folder

Folder to Watch:
/data/shared/rag-files/pending

Watch for:
File Added
Expected output
{
  "event": "add",
  "path": "/data/shared/rag-files/pending/Final Pdf.pdf"
}
2. Read/Write Files from Disk
Node
Read/Write Files from Disk
Purpose

Reads the PDF file from disk as binary data.

Settings
Operation:
Read File(s) From Disk

File(s) Selector:
{{ $json.path }}
Expected output
Binary field: data
File Name: Final Pdf.pdf
Mime Type: application/pdf

This data binary field is sent to Docling.

3. HTTP Request to Docling API
Node
HTTP Request
Purpose

Sends the PDF to Docling for structured markdown extraction.

Settings
Method:
POST

URL:
http://docling:5001/v1/convert/file

Authentication:
None

Send Body:
ON

Body Content Type:
Form-Data
Body fields
Body item 1
Type:
n8n Binary File

Name:
files

Input Data Field Name:
data
Body item 2
Type:
Form Data

Name:
to_formats

Value:
md
Body item 3
Type:
Form Data

Name:
do_ocr

Value:
false
Body item 4
Type:
Form Data

Name:
force_ocr

Value:
false
Expected output
{
  "document": {
    "filename": "Final Pdf.pdf",
    "md_content": "## Clinical Management Guidelines..."
  },
  "status": "success"
}

The key field is:

$json.document.md_content
4. Code Node: Extract Markdown/Text
Node
Code
Rename to
Extract Markdown/Text
Purpose

Extracts the markdown from Docling and simplifies the output.

Settings
Mode:
Run Once for All Items

Language:
JavaScript
Code
return [
  {
    json: {
      text: $json.document.md_content,
      filename: $json.document.filename,
      source: "Clinical Management Guidelines PDF"
    }
  }
];
Expected output
{
  "text": "## Clinical Management Guidelines...",
  "filename": "Final Pdf.pdf",
  "source": "Clinical Management Guidelines PDF"
}
5. Code Node: Split by Condition + Variant and Add Metadata
Node
Code
Rename to
Split by Condition + Variant and Add Metadata
Purpose

Splits the guideline into condition groups and variants.

It converts the PDF text into clinical pathway objects.

Settings
Mode:
Run Once for All Items

Language:
JavaScript
Code
const markdown = $json.text || "";
const filename = $json.filename || "Final Pdf.pdf";
const source = $json.source || "Clinical Management Guidelines PDF";

const sections = markdown.split(/\n## (?=\d+\.\s+)/g);

const output = [];

for (const section of sections) {
  const conditionMatch = section.match(/^(\d+\.\s+[^\n]+)/);
  if (!conditionMatch) continue;

  const conditionGroup = conditionMatch[1]
    .replace(/^\d+\.\s*/, "")
    .trim();

  const variantParts = section.split(/\n## Variant\s+\d+:\s+/g);

  for (let i = 1; i < variantParts.length; i++) {
    const part = variantParts[i];

    const lines = part.trim().split("\n");
    const variant = lines[0].trim();

    const content = lines.slice(1).join("\n").trim();

    let severity = "routine";

    if (/shock|airway compromise|respiratory distress|seizure|altered level of consciousness|sepsis|active bleeding/i.test(content + " " + variant)) {
      severity = "critical";
    } else if (/severe|urgent|admission|refer|specialist/i.test(content + " " + variant)) {
      severity = "urgent";
    }

    output.push({
      json: {
        pageContent: `Condition Group: ${conditionGroup}\nVariant: ${variant}\nSeverity: ${severity}\n\n${content}`,
        metadata: {
          condition_group: conditionGroup,
          variant: variant,
          severity: severity,
          source: source,
          filename: filename
        }
      }
    });
  }
}

return output;
Expected output

Example:

{
  "pageContent": "Condition Group: Per Vaginal Bleeding\nVariant: Non-Pregnant Patient with Signs of Shock...",
  "metadata": {
    "condition_group": "Per Vaginal Bleeding",
    "variant": "Non-Pregnant Patient with Signs of Shock",
    "severity": "critical",
    "source": "Clinical Management Guidelines PDF",
    "filename": "Final Pdf.pdf"
  }
}

Your workflow produced about 33 clinical pathway items at this stage.

6. Code Node: Add Clinical Keywords / Drugs / Criteria Metadata
Node
Code
Rename to
Add Clinical Keywords / Drugs / Criteria Metadata
Purpose

Adds searchable clinical metadata so the system can retrieve a pathway even when the doctor gives incomplete information.

Example doctor input:

salbutamol

or:

shock pv bleeding

or:

insulin vomiting abdominal pain

This node enriches each pathway with:

criteria
medications
investigations
procedures
red_flags
Settings
Mode:
Run Once for All Items

Language:
JavaScript
Code
const items = $input.all();

const keywordMap = {
  red_flags: [
    "shock", "active bleeding", "respiratory distress", "airway compromise",
    "altered level of consciousness", "seizure", "sepsis", "severe pain",
    "unconscious", "hypovolaemic shock", "hypovolemic shock"
  ],
  medications: [
    "tranexamic acid", "ceftriaxone", "metronidazole", "cefuroxime",
    "methyldopa", "magnesium sulphate", "magnesium sulfate", "hydralazine",
    "labetalol", "nifedipine", "salbutamol", "adrenaline", "insulin",
    "calcium gluconate", "sodium bicarbonate", "dextrose", "normal saline",
    "ringer lactate", "ringer's lactate", "paracetamol", "amoxicillin",
    "amoxicillin/clavulanate", "artemether/lumefantrine"
  ],
  investigations: [
    "complete blood count", "CBC", "cross-match", "pelvic ultrasound",
    "malaria antigen test", "blood glucose", "urine ketones", "serum potassium",
    "serum sodium", "electrocardiogram", "ECG", "echocardiogram",
    "chest x-ray", "ultrasound", "renal function", "urea", "creatinine"
  ],
  procedures: [
    "ABC", "airway breathing circulation", "iv access", "intravenous access",
    "fluid resuscitation", "needle decompression", "oxygen", "admission",
    "specialist review", "gynaecological review", "obstetric assessment"
  ],
  symptoms: [
    "per vaginal bleeding", "pv bleeding", "fever", "hotness of body",
    "wheeze", "difficulty breathing", "polyuria", "polydipsia",
    "vomiting", "abdominal pain", "chest pain", "head injury",
    "burns", "convulsion", "seizure"
  ]
};

function findTerms(text, terms) {
  const lower = text.toLowerCase();
  return terms.filter(term => lower.includes(term.toLowerCase()));
}

return items.map(item => {
  const text = item.json.pageContent || "";
  const existingMetadata = item.json.metadata || {};

  const criteria = [
    ...findTerms(text, keywordMap.symptoms),
    ...findTerms(text, keywordMap.red_flags)
  ];

  const medications = findTerms(text, keywordMap.medications);
  const investigations = findTerms(text, keywordMap.investigations);
  const procedures = findTerms(text, keywordMap.procedures);
  const red_flags = findTerms(text, keywordMap.red_flags);

  const searchable_text = [
    text,
    criteria.join(" "),
    medications.join(" "),
    investigations.join(" "),
    procedures.join(" "),
    red_flags.join(" ")
  ].join("\n");

  return {
    json: {
      pageContent: searchable_text,
      metadata: {
        ...existingMetadata,
        criteria: [...new Set(criteria)],
        medications: [...new Set(medications)],
        investigations: [...new Set(investigations)],
        procedures: [...new Set(procedures)],
        red_flags: [...new Set(red_flags)]
      }
    }
  };
});
Expected output
{
  "pageContent": "Condition Group: Per Vaginal Bleeding...",
  "metadata": {
    "condition_group": "Per Vaginal Bleeding",
    "variant": "Non-Pregnant Patient with Signs of Shock",
    "severity": "critical",
    "criteria": ["per vaginal bleeding", "shock", "hypovolaemic shock"],
    "medications": ["tranexamic acid", "ceftriaxone", "metronidazole"],
    "investigations": ["complete blood count", "cross-match", "pelvic ultrasound"],
    "procedures": ["intravenous access", "fluid resuscitation", "admission"],
    "red_flags": ["shock", "hypovolaemic shock"]
  }
}
7. Code Node: Chunk Pathway Text
Node
Code
Rename to
Chunk Pathway Text
Purpose

Splits each clinical pathway into smaller chunks before Qdrant insertion.

This replaces the n8n Recursive Character Text Splitter because your n8n version required a document loader and created complications.

Settings
Mode:
Run Once for All Items

Language:
JavaScript
Code
const items = $input.all();

const chunkSize = 1500;
const overlap = 200;

function chunkText(text, size, overlap) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end));
    start += size - overlap;
  }

  return chunks;
}

const output = [];

for (const item of items) {
  const text = item.json.pageContent || "";
  const metadata = item.json.metadata || {};

  const chunks = chunkText(text, chunkSize, overlap);

  chunks.forEach((chunk, index) => {
    output.push({
      json: {
        text: chunk,
        metadata: {
          ...metadata,
          chunk_index: index,
          chunk_count: chunks.length
        }
      }
    });
  });
}

return output;
Chunk settings
Chunk Size:
1500

Chunk Overlap:
200
Expected output
{
  "text": "Condition Group: Per Vaginal Bleeding...",
  "metadata": {
    "condition_group": "Per Vaginal Bleeding",
    "variant": "Non-Pregnant Patient with Signs of Shock",
    "severity": "critical",
    "chunk_index": 0,
    "chunk_count": 2
  }
}

Your workflow produced about 38 chunks here.

8. Code Node: Prepare Text For Loader
Node
Code
Rename to
Prepare Text For Loader
Purpose

Prepares clean text for the Default Data Loader.

This step is important because Default Data Loader was expanding JSON fields into many tiny documents.

Settings
Mode:
Run Once for All Items

Language:
JavaScript
Final code used
return $input.all().map(item => {
  return {
    json: {
      data: item.json.text
    }
  };
});
Expected output
{
  "data": "Condition Group: Per Vaginal Bleeding..."
}

This removes metadata temporarily to prevent n8n from exploding the JSON into hundreds of tiny fragments.

9. Default Data Loader
Node
Default Data Loader
Purpose

Converts the prepared JSON text into documents that Qdrant can insert.

Settings
Type of Data:
JSON

Mode:
Load All Input Data

Text Splitting:
Simple
Options

Leave empty for now.

Do not add metadata here if it causes document expansion.

Do not connect Recursive Character Text Splitter.

Important

You already chunked manually in:

Chunk Pathway Text

So the Default Data Loader should only pass documents to Qdrant.

10. Embeddings Ollama
Node
Embeddings Ollama
Purpose

Generates vector embeddings for each clinical text chunk.

Settings
Base URL:
http://ollama:11434

Model:
nomic-embed-text

Alternative if Ollama runs on host machine:

http://host.docker.internal:11434
Connection

This node is NOT connected inline.

It connects to the Qdrant node's:

Embeddings

port.

Visual:

Qdrant Vector Store
      ↑
Embeddings Ollama
11. Qdrant Vector Store
Node
Qdrant Vector Store
Purpose

Stores the embedded clinical chunks inside Qdrant.

Action

Choose:

Add documents to vector store

or, depending on your version:

Operation Mode:
Insert Documents
Settings
Credential:
Local QdrantApi database

Operation Mode:
Insert Documents

Qdrant Collection:
MedicalAi

Embedding Batch Size:
200

Your existing collection:

MedicalAi

has:

Vector size: 768
Distance: Cosine
Status: green

This is compatible with:

nomic-embed-text
Connections

Main flow:

Prepare Text For Loader
        ↓
Qdrant Vector Store

Sub-node connections:

Default Data Loader -> Qdrant Document port
Embeddings Ollama -> Qdrant Embeddings port

Visual:

Prepare Text For Loader
        ↓
Qdrant Vector Store
        ↑              ↑
Default Data Loader   Embeddings Ollama
Document port         Embeddings port
FINAL WORKING FLOW
Local File Trigger
        ↓
Read/Write Files from Disk
        ↓
HTTP Request to Docling API
        ↓
Extract Markdown/Text
        ↓
Split by Condition + Variant and Add Metadata
        ↓
Add Clinical Keywords / Drugs / Criteria Metadata
        ↓
Chunk Pathway Text
        ↓
Prepare Text For Loader
        ↓
Qdrant Vector Store
              ↑
        Embeddings Ollama

With Qdrant sub-nodes:

Default Data Loader -> Qdrant Document port
Embeddings Ollama -> Qdrant Embeddings port
FINAL EXPECTED OUTPUT

Your final successful run should show approximately:

Input to Qdrant:
38 items

Output from Qdrant:
Around 47 items

That is acceptable.

The earlier bad output was:

1180 / 1189 items

That meant the loader was incorrectly flattening the JSON.

The corrected flow avoids that.

What This Workflow Achieves

This workflow turns your clinical PDF into a searchable pathway knowledge base.

It supports retrieval from:

symptoms
drugs
procedures
investigations
red flags
condition names
variant names

Examples of searchable inputs:

non pregnant pv bleeding shock
tranexamic acid
polyuria vomiting abdominal pain
needle decompression
salbutamol wheeze
Important Limitation

Because metadata was removed in Prepare Text For Loader, Qdrant now stores clean text but not full structured metadata.

This is acceptable for the current working version.

Later upgrade:

Store metadata properly without Default Data Loader flattening JSON

The future best version is to insert structured JSON directly or use a loader that supports:

text field = data
metadata field = metadata

without flattening.

For now, your ingestion system is operational and ready for retrieval testing.
