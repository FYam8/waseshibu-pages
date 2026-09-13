#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_AUTH_TOKEN;
const model = process.env.WORKERS_AI_MODEL || '@cf/google/gemma-4-26b-a4b-it';
const repeatRuns = Number(process.env.BENCH_REPEAT || 3);

if (!accountId || !token) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AUTH_TOKEN.');
  process.exit(2);
}

const casesPath = path.join(__dirname, '2024', 'solver-cases.json');
const promptPath = path.join(__dirname, 'prompts', 'solver-v1.txt');
const casesData = JSON.parse(await fs.readFile(casesPath, 'utf8'));
const promptTemplate = await fs.readFile(promptPath, 'utf8');

function renderPrompt(testCase) {
  return promptTemplate
    .replace('{{PASSAGE}}', testCase.passageExcerpt)
    .replace('{{QUESTION}}', testCase.prompt);
}

async function runOne(testCase, runNo) {
  const input = {
    messages: [
      {
        role: 'user',
        content: renderPrompt(testCase),
      },
    ],
    temperature: 0,
    max_completion_tokens: 256,
    seed: 42,
    chat_template_kwargs: {
      enable_thinking: true,
    },
  };

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
  createdAt: new Date().toISOString(),
  model,
  settings: {
    temperature: 0,
    seed: 42,
    thinking: true,
    repeatRuns,
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
