#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL = '@cf/google/gemma-4-26b-a4b-it';
const MODEL_SLUG = 'gemma-4-26b-a4b-it';
const modelUrl = `https://playground.ai.cloudflare.com/models?model=${encodeURIComponent(MODEL)}`;

const casesPath = path.join(__dirname, '2024', 'solver-cases.json');
const promptPath = path.join(__dirname, 'prompts', 'solver-v1.txt');
const casesData = JSON.parse(await fs.readFile(casesPath, 'utf8'));
const promptTemplate = await fs.readFile(promptPath, 'utf8');
const repeatRuns = Number(process.env.BENCH_REPEAT || casesData.rules?.repeatRuns || 3);

if (!Number.isInteger(repeatRuns) || repeatRuns < 1 || repeatRuns > 10) {
  throw new Error('BENCH_REPEAT must be an integer from 1 to 10.');
}

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

async function openPdf(bytes) {
  return getDocument({ data: bytes, disableWorker: true }).promise;
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
  const question = extractCompactBetween(
    questionPage,
    testCase.questionLocator,
    `${testCase.id} question`,
  );
  return { passage, question };
}

function renderPrompt({ passage, question }) {
  return promptTemplate
    .replace('{{PASSAGE}}', passage)
    .replace('{{QUESTION}}', question);
}

function extractAssistantAnswer(bodyText) {
  const marker = '\nAssistant\n';
  const start = bodyText.lastIndexOf(marker);
  if (start < 0) throw new Error('Assistant response marker not found in Playground output.');
  const after = bodyText.slice(start + marker.length).trimStart();
  const panelMarkers = ['\n\nModel\nConnection', '\nModel\nConnection'];
  let end = after.length;
  for (const panelMarker of panelMarkers) {
    const index = after.indexOf(panelMarker);
    if (index >= 0) end = Math.min(end, index);
  }
  const answer = after.slice(0, end).trim();
  if (!answer) throw new Error('Assistant response was empty.');
  return answer;
}

function parseParts(answer, parts) {
  const result = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const laterIds = parts.slice(index + 1).map((item) => item.id).join('|');
    const stop = laterIds ? `(?=\\s*(?:${laterIds})\\s*[：:]|$)` : '$';
    const regex = new RegExp(`${part.id}\\s*[：:]\\s*(.+?)${stop}`, 's');
    const match = answer.match(regex);
    const value = match?.[1]?.trim() ?? null;
    const charCount = value === null ? null : codePointLength(value);
    result[part.id] = {
      value,
      found: value !== null,
      charCount,
      maxChars: part.maxChars,
      withinLimit: value !== null && charCount <= part.maxChars,
    };
  }
  return result;
}

function hardConstraintCheck(testCase, answer) {
  if (testCase.maxChars) {
    const charCount = codePointLength(answer);
    const found = charCount > 0;
    return {
      kind: 'single',
      found,
      charCount,
      maxChars: testCase.maxChars,
      withinLimit: found && charCount <= testCase.maxChars,
      pass: found && charCount <= testCase.maxChars,
    };
  }
  if (Array.isArray(testCase.parts)) {
    const parts = parseParts(answer, testCase.parts);
    return {
      kind: 'parts',
      parts,
      pass: Object.values(parts).every((part) => part.found && part.withinLimit),
    };
  }
  return null;
}

const pdfBytes = await downloadPdf(casesData.source.problemPdf);
const pdfHash = sha256(pdfBytes);
const promptHash = sha256(promptTemplate);
const pdf = await openPdf(pdfBytes);

const preparedCases = new Map();
for (const testCase of casesData.cases) {
  const input = await buildCaseInputs(pdf, testCase);
  preparedCases.set(testCase.id, {
    prompt: renderPrompt(input),
    passageChars: codePointLength(input.passage),
    questionChars: codePointLength(input.question),
  });
}

const browser = await chromium.launch({ headless: true });
const results = [];

async function runOne(testCase, runNo) {
  const context = await browser.newContext({
    locale: 'ja-JP',
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const startedAt = Date.now();
  try {
    await page.goto(modelUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const textarea = page.locator('textarea[placeholder="Ask anything..."]');
    await textarea.waitFor({ state: 'visible', timeout: 60_000 });

    const provider = await page.getByRole('combobox', { name: 'Provider' }).inputValue();
    const selectedModel = await page.getByRole('combobox', { name: 'Model' }).inputValue();
    if (provider !== 'Google' || !selectedModel.includes(MODEL_SLUG)) {
      throw new Error(`Unexpected Playground selection: provider=${provider}, model=${selectedModel}`);
    }

    const prepared = preparedCases.get(testCase.id);
    await textarea.fill(prepared.prompt);
    await page.getByRole('button', { name: 'Send message' }).click();

    const stop = page.getByRole('button', { name: 'Stop' });
    await stop.waitFor({ state: 'visible', timeout: 15_000 });
    await stop.waitFor({ state: 'hidden', timeout: 180_000 });
    await page.waitForTimeout(1_000);

    const bodyText = await page.locator('body').innerText();
    const answer = extractAssistantAnswer(bodyText);
    const hardConstraints = hardConstraintCheck(testCase, answer);
    return {
      caseId: testCase.id,
      run: runNo,
      answer,
      hardConstraints,
      durationMs: Date.now() - startedAt,
      provider,
      selectedModel,
      passageChars: prepared.passageChars,
      questionChars: prepared.questionChars,
    };
  } catch (error) {
    return {
      caseId: testCase.id,
      run: runNo,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await context.close();
  }
}

try {
  for (const testCase of casesData.cases) {
    for (let runNo = 1; runNo <= repeatRuns; runNo += 1) {
      console.log(`Running ${testCase.id} ${runNo}/${repeatRuns} via Cloudflare Playground...`);
      const result = await runOne(testCase, runNo);
      results.push(result);
      if (result.error) {
        console.log(`  ERROR: ${result.error}`);
      } else {
        console.log(`  ANSWER: ${result.answer.replace(/\s+/g, ' ')}`);
        console.log(`  HARD_CONSTRAINT_PASS: ${result.hardConstraints?.pass ?? 'n/a'}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
} finally {
  await browser.close();
}

const report = {
  schemaVersion: 1,
  benchmark: 'waseshibu-kokugo-solver-playground',
  year: 2024,
  createdAt: new Date().toISOString(),
  model: MODEL,
  connection: 'Cloudflare AI Playground / Workers AI',
  settings: {
    repeatRuns,
    playgroundDefaults: true,
    officialAnswerShownToModel: false,
  },
  source: {
    problemPdf: casesData.source.problemPdf,
    problemPdfSha256: pdfHash,
    promptSha256: promptHash,
    textExtraction: 'pdfjs-dist runtime; no past-exam passage stored in repository or result JSON',
  },
  results,
};

const outDir = path.join(__dirname, 'results');
await fs.mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, `2024-playground-gemma4-${Date.now()}.json`);
await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Saved benchmark result: ${outPath}`);

if (results.some((result) => result.error)) process.exitCode = 1;
