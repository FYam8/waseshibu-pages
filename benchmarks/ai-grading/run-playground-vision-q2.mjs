#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const execFileAsync = promisify(execFile);
const MODEL = '@cf/google/gemma-4-26b-a4b-it';
const MODEL_SLUG = 'gemma-4-26b-a4b-it';
const MODEL_URL = `https://playground.ai.cloudflare.com/models?model=${encodeURIComponent(MODEL)}`;
const PROBLEM_PDF = 'https://www.waseda-shibuya.edu.sg/assets/upload/files/e84fc32c4eac71d3616a4743a3bf47eb1712047203.pdf';
const repeatRuns = Number(process.env.BENCH_REPEAT || 3);
const technicalRetries = Number(process.env.BENCH_TECH_RETRIES || 3);
const outDir = path.resolve('benchmarks/ai-grading/results');
await fs.mkdir(outDir, { recursive: true });

function codePointLength(text) {
  return [...String(text ?? '').trim()].length;
}

async function downloadPdf(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Waseda-Shibuya-AI-Benchmark/1.0' } });
  if (!response.ok) throw new Error(`PDF download failed: ${response.status}`);
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

async function renderQuestionPage(pdfBytes) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kokugo-q2-'));
  const pdfPath = path.join(dir, 'exam.pdf');
  const outPrefix = path.join(dir, 'q2-question');
  await fs.writeFile(pdfPath, pdfBytes);
  // Official PDF page index 25 => PDF page 26. Low-DPI grayscale keeps the WebSocket payload compact.
  await execFileAsync('pdftoppm', ['-f', '26', '-l', '26', '-singlefile', '-gray', '-r', '100', '-png', pdfPath, outPrefix]);
  const pngPath = `${outPrefix}.png`;
  const png = await fs.readFile(pngPath);
  return { png, pngPath };
}

function parseParts(answer) {
  const result = {};
  for (const [id, maxChars] of [['甲', 10], ['乙', 10]]) {
    const stop = id === '甲' ? '(?=\\s*乙\\s*[：:]|$)' : '$';
    const regex = new RegExp(`${id}\\s*[：:]\\s*(.+?)${stop}`, 's');
    const match = answer.match(regex);
    const value = match?.[1]?.trim() ?? null;
    const chars = value === null ? null : codePointLength(value);
    result[id] = { value, found: value !== null, charCount: chars, maxChars, withinLimit: chars !== null && chars <= maxChars };
  }
  return result;
}

function buildUserText(passage) {
  return [
    'あなたは高校入試・国語の受験者です。',
    '以下の本文抜粋と添付画像に写っている2024年度国語・大問二・問六を解いてください。',
    '画像内の設問・図式をそのまま読み取り、甲・乙をそれぞれ10字以内（句読点等を含む）で補ってください。',
    '公式解答は与えられていません。本文と画像だけを根拠にしてください。',
    '出力は「甲：...　乙：...」だけにしてください。理由や解説は不要です。',
    '',
    '【本文抜粋】',
    passage,
  ].join('\n');
}

const pdfBytes = await downloadPdf(PROBLEM_PDF);
// Render before handing the Uint8Array to PDF.js. PDF.js may transfer/detach the source ArrayBuffer.
const { png } = await renderQuestionPage(pdfBytes.slice());
const pdf = await getDocument({ data: pdfBytes, disableWorker: true }).promise;
const focusedPages = [];
for (const pageIndex of [16, 17, 18]) focusedPages.push(await pageText(pdf, pageIndex));
const passage = focusedPages.join('\n\n');
const imageDataUrl = `data:image/png;base64,${png.toString('base64')}`;

const browser = await chromium.launch({ headless: true });

async function runAttempt(runNo, technicalAttempt) {
  const context = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const OriginalWebSocket = window.WebSocket;
    window.__cfSockets = [];
    window.__cfFrames = [];
    class CapturedWebSocket extends OriginalWebSocket {
      constructor(...args) {
        super(...args);
        window.__cfSockets.push(this);
        this.addEventListener('message', (event) => {
          if (typeof event.data === 'string') window.__cfFrames.push(event.data);
        });
      }
    }
    window.WebSocket = CapturedWebSocket;
  });

  const started = Date.now();
  const requestId = crypto.randomUUID();
  try {
    await page.goto(MODEL_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.locator('textarea[placeholder="Ask anything..."]').waitFor({ state: 'visible', timeout: 60_000 });
    await page.waitForFunction(
      (slug) => {
        const model = document.querySelector('input[aria-label="Model"]');
        const provider = document.querySelector('input[aria-label="Provider"]');
        return model?.value?.includes(slug) && provider?.value === 'Google' && window.__cfSockets?.some((ws) => ws.readyState === WebSocket.OPEN);
      },
      MODEL_SLUG,
      { timeout: 60_000 },
    );

    const body = {
      messages: [{
        role: 'user',
        parts: [
          { type: 'text', text: buildUserText(passage) },
          { type: 'file', mediaType: 'image/png', filename: '2024-kokugo-q2-question.png', url: imageDataUrl },
        ],
        id: crypto.randomUUID(),
      }],
      trigger: 'submit-message',
    };
    const wire = {
      id: requestId,
      init: { method: 'POST', body: JSON.stringify(body) },
      type: 'cf_agent_use_chat_request',
    };

    await page.evaluate((payload) => {
      const ws = [...window.__cfSockets].reverse().find((item) => item.readyState === WebSocket.OPEN);
      if (!ws) throw new Error('No open Playground WebSocket');
      ws.send(JSON.stringify(payload));
    }, wire);

    await page.waitForFunction(
      (id) => window.__cfFrames.some((raw) => {
        try {
          const frame = JSON.parse(raw);
          return frame.type === 'cf_agent_use_chat_response' && frame.id === id && frame.done === true;
        } catch { return false; }
      }),
      requestId,
      { timeout: 240_000 },
    );

    const frames = await page.evaluate(() => [...window.__cfFrames]);
    const text = [];
    const reasoning = [];
    const errors = [];
    for (const raw of frames) {
      let outer;
      try { outer = JSON.parse(raw); } catch { continue; }
      if (outer.type !== 'cf_agent_use_chat_response' || outer.id !== requestId) continue;
      if (outer.error) errors.push(String(outer.error));
      if (!outer.body) continue;
      let chunk;
      try { chunk = JSON.parse(outer.body); } catch { continue; }
      if (chunk.type === 'text-delta') text.push(chunk.delta ?? '');
      if (chunk.type === 'reasoning-delta') reasoning.push(chunk.delta ?? '');
      if (chunk.type === 'error') errors.push(chunk.errorText ?? chunk.message ?? JSON.stringify(chunk));
    }
    const answer = text.join('').trim();
    if (!answer) throw new Error(`No text answer. errors=${JSON.stringify(errors).slice(0, 1000)}`);
    const parts = parseParts(answer);
    return {
      run: runNo,
      technicalAttempt,
      answer,
      parts,
      hardConstraintPass: Object.values(parts).every((part) => part.found && part.withinLimit),
      durationMs: Date.now() - started,
      reasoningChars: reasoning.join('').length,
    };
  } finally {
    await context.close();
  }
}

const results = [];
try {
  for (let runNo = 1; runNo <= repeatRuns; runNo += 1) {
    let lastError = null;
    let result = null;
    for (let attempt = 1; attempt <= technicalRetries; attempt += 1) {
      try {
        result = await runAttempt(runNo, attempt);
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < technicalRetries) await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    if (!result) result = { run: runNo, error: lastError };
    results.push(result);
    console.log(JSON.stringify(result));
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
} finally {
  await browser.close();
}

const report = {
  schemaVersion: 1,
  benchmark: 'waseshibu-kokugo-2024-q2-vision-diagnostic',
  createdAt: new Date().toISOString(),
  model: MODEL,
  officialAnswerShownToModel: false,
  inputMode: 'focused official passage text + rendered official question page image',
  imageBytes: png.length,
  passageChars: codePointLength(passage),
  results,
};
const outPath = path.join(outDir, `2024-q2-vision-${Date.now()}.json`);
await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Saved ${outPath}`);
if (results.some((r) => r.error)) process.exitCode = 1;
