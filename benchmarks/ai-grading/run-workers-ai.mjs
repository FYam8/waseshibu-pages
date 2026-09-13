#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_AUTH_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
const model = process.env.WORKERS_AI_MODEL || '@cf/google/gemma-4-26b-a4b-it';
const repeatRuns = Number(process.env.BENCH_REPEAT || 3);
const temperature = Number(process.env.BENCH_TEMPERATURE ?? 0);
const fixedSeed = process.env.BENCH_SEED === undefined ? null : Number(process.env.BENCH_SEED);
const thinking = process.env.BENCH_THINKING !== 'false';
const reasoningEffort = process.env.BENCH_REASONING_EFFORT || 'low';

if (!accountId || !token) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AUTH_TOKEN (or CLOUDFLARE_API_TOKEN).');
  process.exit(2);
}
if (!Number.isInteger(repeatRuns) || repeatRuns < 1 || repeatRuns > 10) {
  throw new Error('BENCH_REPEAT must be an integer from 1 to 10.');
}
if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
  throw new Error('BENCH_TEMPERATURE must be between 0 and 2.');
}
if (fixedSeed !== null && !Number.isFinite(fixedSeed)) {
  throw new Error('BENCH_SEED must be numeric when provided.');
}

const casesPath = path.join(__dirname, '2024', 'solver-cases.json');
const promptPath = path.join(__dirname, 'prompts', 'solver-v1.txt');
const casesData = JSON.parse(await fs.readFile(casesPath, 'utf8'));
const promptTemplate = await fs.readFile(promptPath, 'utf8');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function codePointLength(text) {
  return [...String(text ?? '').trim()].length;
}
function compact(text) {
  return String(text ?? '').replace(/\s+/g, '');
}
function extractCompactBetween(text, locator, label) {
  const source = compact(text);
  const startMarker = compact(locator.start);
  const endMarker = compact(locator.end);
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`${label}: start marker not found: ${locator.start}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`${label}: end marker not found: ${locator.end}`);
  return source.slice(start, end);
}
async function downloadPdf(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 Waseda-Shibuya-AI-Benchmark/1.0' },
  });
  if (!response.ok) throw new Error(`Official PDF download failed: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
async function pageText(pdf, zeroBasedIndex) {
  const page = await pdf.getPage(zeroBasedIndex + 1);
  const content = await page.getTextContent();
  let out = '';
  for (const item of content.items) {
    if (!('str' in item)) continue;
    out += item.str;
    out += item.hasEOL ? '\n' : ' ';
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
}
async function buildCaseInputs(pdf, testCase) {
  const passagePages = [];
  for (const pageIndex of testCase.passagePageIndexes) {
    passagePages.push(await pageText(pdf, pageIndex));
  }
  const passage = passagePages.join('\n\n');
  const questionPage = await pageText(pdf, testCase.questionPageIndex);
  const question = extractCompactBetween(questionPage, testCase.questionLocator, `${testCase.id} question`);
  return { passage, question };
}
function renderPrompt({ passage, question }) {
  return promptTemplate.replace('{{PASSAGE}}', passage).replace('{{QUESTION}}', question);
}
function modelSpecificOptions() {
  if (model === '@cf/google/gemma-4-26b-a4b-it') {
    return { chat_template_kwargs: { enable_thinking: thinking } };
  }
  return {};
}
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function hardConstraintCheck(testCase, answer) {
  const text = String(answer ?? '').trim();
  if (testCase.maxChars) {
    const chars = codePointLength(text);
    const found = text.length > 0;
    return { kind: 'single', found, charCount: chars, maxChars: testCase.maxChars, withinLimit: found && chars <= testCase.maxChars, pass: found && chars <= testCase.maxChars };
  }
  if (Array.isArray(testCase.parts)) {
    const out = { kind: 'parts', parts: {}, pass: false };
    for (let index = 0; index < testCase.parts.length; index += 1) {
      const part = testCase.parts[index];
      const laterIds = testCase.parts.slice(index + 1).map((item) => escapeRegExp(item.id));
      const stop = laterIds.length ? `(?=\\s*(?:${laterIds.join('|')})\\s*[：:]|$)` : '$';
      const pattern = new RegExp(`${escapeRegExp(part.id)}\\s*[：:]\\s*(.+?)${stop}`, 's');
      const match = text.match(pattern);
      const value = match?.[1]?.trim() ?? null;
      const chars = value === null ? null : codePointLength(value);
      const found = value !== null && value.length > 0;
      const withinLimit = found && chars <= part.maxChars;
      out.parts[part.id] = { value, charCount: chars, maxChars: part.maxChars, found, withinLimit };
    }
    out.pass = testCase.parts.every((part) => out.parts[part.id]?.found && out.parts[part.id]?.withinLimit);
    return out;
  }
  return null;
}

const pdfBytes = await downloadPdf(casesData.source.problemPdf);
const pdfHash = sha256(pdfBytes);
const promptHash = sha256(promptTemplate);
const pdf = await getDocument({ data: pdfBytes, disableWorker: true }).promise;
const preparedCases = new Map();
for (const testCase of casesData.cases) {
  const input = await buildCaseInputs(pdf, testCase);
  preparedCases.set(testCase.id, {
    prompt: renderPrompt(input),
    passageChars: codePointLength(input.passage),
    questionChars: codePointLength(input.question),
  });
}

async function runOne(testCase, runNo) {
  const prepared = preparedCases.get(testCase.id);
  const input = {
    messages: [{ role: 'user', content: prepared.prompt }],
    temperature,
    reasoning_effort: reasoningEffort,
    max_completion_tokens: 2048,
    ...modelSpecificOptions(),
  };
  if (fixedSeed !== null) input.seed = fixedSeed;

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
  const started = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const raw = await response.json();
  if (!response.ok || raw.success === false) {
    throw new Error(`${testCase.id} run ${runNo}: HTTP ${response.status} ${JSON.stringify(raw)}`);
  }
  const result = raw.result ?? raw;
  const answer = result.response ?? result.choices?.[0]?.message?.content ?? result.output_text ?? null;
  if (typeof answer !== 'string' || !answer.trim()) {
    throw new Error(`${testCase.id} run ${runNo}: no text answer in ${JSON.stringify(result)}`);
  }
  return {
    caseId: testCase.id,
    run: runNo,
    model,
    answer: answer.trim(),
    hardConstraints: hardConstraintCheck(testCase, answer),
    latencyMs: Date.now() - started,
    usage: result.usage ?? null,
    systemFingerprint: result.system_fingerprint ?? null,
    passageChars: prepared.passageChars,
    questionChars: prepared.questionChars,
  };
}

const results = [];
for (const testCase of casesData.cases) {
  for (let run = 1; run <= repeatRuns; run += 1) {
    console.error(`Running ${testCase.id} (${run}/${repeatRuns}) on ${model}...`);
    try {
      const result = await runOne(testCase, run);
      results.push(result);
      console.error(`  ANSWER: ${result.answer.replace(/\s+/g, ' ')}`);
      console.error(`  HARD_CONSTRAINT_PASS: ${result.hardConstraints?.pass ?? 'n/a'}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ caseId: testCase.id, run, model, error: message });
      console.error(`  ERROR: ${message}`);
    }
  }
}

const report = {
  schemaVersion: 2,
  benchmark: 'waseshibu-kokugo-solver-workers-ai',
  year: 2024,
  sourceMode: casesData.rules?.contextMode ?? null,
  createdAt: new Date().toISOString(),
  model,
  settings: {
    temperature,
    seed: fixedSeed,
    thinking: model === '@cf/google/gemma-4-26b-a4b-it' ? thinking : null,
    repeatRuns,
    reasoningEffort,
    maxCompletionTokens: 2048,
    officialAnswerShownToModel: false,
  },
  source: {
    problemPdf: casesData.source.problemPdf,
    problemPdfSha256: pdfHash,
    promptSha256: promptHash,
    textExtraction: 'pdfjs-dist runtime; official answer excluded from prompt',
  },
  results,
};

const safeModel = model.replace(/[^a-zA-Z0-9._-]+/g, '_');
const outDir = path.join(__dirname, 'results');
await fs.mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, `2024-${safeModel}-${Date.now()}.json`);
await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
console.error(`Saved: ${outPath}`);

if (results.some((result) => result.error)) process.exitCode = 1;
