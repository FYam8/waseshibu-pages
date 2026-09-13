#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_AUTH_TOKEN;
const model = process.env.WORKERS_AI_MODEL || '@cf/google/gemma-4-26b-a4b-it';
const repeatRuns = Number(process.env.BENCH_REPEAT || 3);
const temperature = Number(process.env.BENCH_TEMPERATURE ?? 0);
const fixedSeed = process.env.BENCH_SEED === undefined ? null : Number(process.env.BENCH_SEED);
const thinking = process.env.BENCH_THINKING !== 'false';

if (!accountId || !token) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AUTH_TOKEN.');
  process.exit(2);
}

if (!Number.isFinite(repeatRuns) || repeatRuns < 1) {
  throw new Error('BENCH_REPEAT must be a positive number.');
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

function compact(text) {
  return String(text ?? '').replace(/\s+/g, '');
}

function extractBetween(text, locator, label) {
  const source = compact(text);
  const startMarker = compact(locator.start);
  const endMarker = compact(locator.end);
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`${label}: start marker not found: ${locator.start}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`${label}: end marker not found: ${locator.end}`);
  return source.slice(start, end);
}

async function fetchOfficialProblemText() {
  const sourceUrl = casesData.source?.problemPdf;
  if (!sourceUrl) throw new Error('solver-cases.json is missing source.problemPdf');

  const pdfResponse = await fetch(sourceUrl);
  if (!pdfResponse.ok) {
    throw new Error(`Failed to download official PDF: ${pdfResponse.status}`);
  }

  const pdfBytes = await pdfResponse.arrayBuffer();
  const form = new FormData();
  form.append(
    'files',
    new Blob([pdfBytes], { type: 'application/pdf' }),
    'waseshibu-2024-kokugo.pdf',
  );
  form.append(
    'conversionOptions',
    JSON.stringify({ output: { format: 'text' }, pdf: { metadata: false } }),
  );

  const conversionResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/tomarkdown`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    },
  );

  const raw = await conversionResponse.json();
  if (!conversionResponse.ok || raw.success === false) {
    throw new Error(`PDF conversion failed: ${conversionResponse.status} ${JSON.stringify(raw)}`);
  }

  const converted = raw.result?.[0];
  if (!converted || converted.format === 'error' || typeof converted.data !== 'string') {
    throw new Error(`PDF conversion returned no usable text: ${JSON.stringify(converted)}`);
  }

  return converted.data;
}

const officialProblemText = await fetchOfficialProblemText();

function buildCase(testCase) {
  const passage = extractBetween(
    officialProblemText,
    testCase.passageLocator,
    `${testCase.id} passage`,
  );
  const question = extractBetween(
    officialProblemText,
    testCase.questionLocator,
    `${testCase.id} question`,
  );
  return { passage, question };
}

function renderPrompt(testCase) {
  const { passage, question } = buildCase(testCase);
  return promptTemplate
    .replace('{{PASSAGE}}', passage)
    .replace('{{QUESTION}}', question);
}

function modelSpecificOptions() {
  if (model === '@cf/google/gemma-4-26b-a4b-it') {
    return { chat_template_kwargs: { enable_thinking: thinking } };
  }
  return {};
}

function codePointLength(text) {
  return [...String(text ?? '').trim()].length;
}

function hardConstraintCheck(testCase, answer) {
  const text = String(answer ?? '').trim();
  if (testCase.maxChars) {
    const chars = codePointLength(text);
    return {
      kind: 'single',
      charCount: chars,
      maxChars: testCase.maxChars,
      withinLimit: chars <= testCase.maxChars,
    };
  }

  if (Array.isArray(testCase.parts)) {
    const out = { kind: 'parts', parts: {} };
    for (const part of testCase.parts) {
      const pattern = new RegExp(`${part.id}\\s*[：:]\\s*([^\\n\\r]+)`);
      const match = text.match(pattern);
      const value = match?.[1]?.trim() ?? null;
      const chars = value === null ? null : codePointLength(value);
      out.parts[part.id] = {
        value,
        charCount: chars,
        maxChars: part.maxChars,
        found: value !== null,
        withinLimit: chars !== null ? chars <= part.maxChars : false,
      };
    }
    return out;
  }

  return null;
}

async function runOne(testCase, runNo) {
  const input = {
    messages: [
      {
        role: 'user',
        content: renderPrompt(testCase),
      },
    ],
    temperature,
    max_completion_tokens: 512,
    ...modelSpecificOptions(),
  };

  if (fixedSeed !== null) input.seed = fixedSeed;

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
  const started = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  const raw = await response.json();
  if (!response.ok || raw.success === false) {
    throw new Error(`${testCase.id} run ${runNo}: ${response.status} ${JSON.stringify(raw)}`);
  }

  const result = raw.result ?? raw;
  const answer =
    result.response ??
    result.choices?.[0]?.message?.content ??
    result.output_text ??
    null;

  return {
    caseId: testCase.id,
    run: runNo,
    model,
    answer,
    hardConstraints: hardConstraintCheck(testCase, answer),
    latencyMs: Date.now() - started,
    usage: result.usage ?? null,
    systemFingerprint: result.system_fingerprint ?? null,
  };
}

const results = [];
for (const testCase of casesData.cases) {
  for (let run = 1; run <= repeatRuns; run += 1) {
    console.error(`Running ${testCase.id} (${run}/${repeatRuns}) on ${model}...`);
    results.push(await runOne(testCase, run));
  }
}

const report = {
  benchmark: 'waseshibu-kokugo-solver',
  year: 2024,
  sourceMode: casesData.rules?.contextMode ?? null,
  createdAt: new Date().toISOString(),
  model,
  settings: {
    temperature,
    seed: fixedSeed,
    thinking: model === '@cf/google/gemma-4-26b-a4b-it' ? thinking : null,
    repeatRuns,
    maxCompletionTokens: 512,
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
