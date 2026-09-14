#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_AUTH_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
const model = process.env.WORKERS_AI_MODEL || '@cf/google/gemma-4-26b-a4b-it';
const repeatRuns = Number(process.env.BENCH_REPEAT || 3);
const temperature = Number(process.env.BENCH_TEMPERATURE ?? 0);
const thinking = process.env.BENCH_THINKING === 'true';
const reasoningEffort = process.env.BENCH_REASONING_EFFORT || 'low';
const dryRun = process.env.BENCH_DRY_RUN === 'true';

if (!dryRun && (!accountId || !token)) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AUTH_TOKEN (or CLOUDFLARE_API_TOKEN).');
  process.exit(2);
}
if (!Number.isInteger(repeatRuns) || repeatRuns < 1 || repeatRuns > 5) {
  throw new Error('BENCH_REPEAT must be an integer from 1 to 5.');
}

const casesPath = path.join(__dirname, '2024', 'grader-cases.json');
const promptPath = path.join(__dirname, 'prompts', 'grader-v1.txt');
const casesData = JSON.parse(await fs.readFile(casesPath, 'utf8'));
const promptTemplate = await fs.readFile(promptPath, 'utf8');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function codePointLength(value) {
  return [...String(value ?? '').trim()].length;
}

function modelSpecificOptions() {
  if (
    model === '@cf/google/gemma-4-26b-a4b-it'
    || model === '@cf/zai-org/glm-4.7-flash'
    || model === '@cf/qwen/qwen3.8-27b'
  ) {
    return { chat_template_kwargs: { enable_thinking: thinking } };
  }
  return {};
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const text = content.map((item) => {
    if (typeof item === 'string') return item;
    if (typeof item?.text === 'string') return item.text;
    return '';
  }).join('');
  return text || null;
}

function publicInput() {
  return {
    questions: casesData.questions.map((question) => ({
      id: question.id,
      points: question.points,
      answerFormat: question.answerFormat,
      maxChars: question.maxChars,
      parts: question.parts,
      referenceAnswer: question.referenceAnswer,
      rubric: question.rubric,
      answers: question.answers.map(({ id, answer }) => ({
        answerId: id,
        answer,
        charCount: typeof answer === 'string'
          ? codePointLength(answer)
          : Object.fromEntries(Object.entries(answer).map(([key, value]) => [key, codePointLength(value)])),
      })),
    })),
  };
}

function parseJsonAnswer(answer) {
  const trimmed = answer.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(trimmed);
}

function expectedMap() {
  return new Map(casesData.questions.flatMap((question) => question.answers.map((answer) => [answer.id, {
    verdict: answer.gold,
    partVerdicts: answer.goldPartLabels ?? null,
  }])));
}

function score(parsed) {
  const expected = expectedMap();
  const returned = Array.isArray(parsed?.results) ? parsed.results : [];
  const byId = new Map(returned.map((item) => [item.answerId, item]));
  const comparisons = [];
  for (const [answerId, gold] of expected) {
    const actual = byId.get(answerId);
    const verdictMatch = actual?.verdict === gold.verdict;
    const partMatch = gold.partVerdicts === null || Object.entries(gold.partVerdicts)
      .every(([part, label]) => actual?.partVerdicts?.[part] === label);
    comparisons.push({ answerId, gold: gold.verdict, actual: actual?.verdict ?? null, verdictMatch, partMatch });
  }
  return {
    total: comparisons.length,
    exactVerdicts: comparisons.filter((item) => item.verdictMatch).length,
    exactParts: comparisons.filter((item) => item.partMatch).length,
    missingOrExtraIds: returned.length !== expected.size || comparisons.some((item) => item.actual === null),
    comparisons,
  };
}

const gradingInput = publicInput();
const prompt = promptTemplate.replace('{{GRADING_INPUT}}', JSON.stringify(gradingInput));

if (dryRun) {
  const answerCount = casesData.questions.reduce((total, question) => total + question.answers.length, 0);
  console.log(JSON.stringify({
    valid: true,
    questionCount: casesData.questions.length,
    answerCount,
    promptChars: codePointLength(prompt),
    goldLabelsIncludedInPrompt: prompt.includes('goldReason') || prompt.includes('"gold"'),
    officialPassageShownToModel: false
  }, null, 2));
  process.exit(0);
}

async function runOne(run) {
  const input = {
    messages: [{ role: 'user', content: prompt }],
    temperature,
    reasoning_effort: reasoningEffort,
    max_completion_tokens: 3000,
    ...modelSpecificOptions(),
  };
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
  const started = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const raw = await response.json();
  if (!response.ok || raw.success === false) {
    throw new Error(`run ${run}: HTTP ${response.status} ${JSON.stringify(raw)}`);
  }
  const result = raw.result ?? raw;
  const choice = result.choices?.[0];
  const answer = textFromContent(result.response)
    ?? textFromContent(choice?.message?.content)
    ?? textFromContent(result.output_text)
    ?? textFromContent(result.output);
  if (typeof answer !== 'string' || !answer.trim()) {
    const usage = result.usage ?? {};
    const diagnostic = {
      finishReason: choice?.finish_reason ?? null,
      completionTokens: usage.completion_tokens ?? null,
      hasReasoningContent: Boolean(choice?.message?.reasoning_content),
      resultKeys: Object.keys(result).sort(),
    };
    throw new Error(`run ${run}: no text answer ${JSON.stringify(diagnostic)}`);
  }
  const parsed = parseJsonAnswer(answer);
  return {
    run,
    latencyMs: Date.now() - started,
    usage: result.usage ?? null,
    grading: parsed,
    score: score(parsed),
  };
}

const runs = [];
for (let run = 1; run <= repeatRuns; run += 1) {
  console.error(`Running compact grader batch (${run}/${repeatRuns}) on ${model}...`);
  try {
    const result = await runOne(run);
    runs.push(result);
    console.error(`  EXACT: ${result.score.exactVerdicts}/${result.score.total}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runs.push({ run, error: message });
    console.error(`  ERROR: ${message}`);
  }
}

const report = {
  schemaVersion: 1,
  benchmark: casesData.benchmark,
  year: casesData.year,
  createdAt: new Date().toISOString(),
  model,
  settings: {
    temperature,
    reasoningEffort,
    maxCompletionTokens: 3000,
    thinking: (model === '@cf/google/gemma-4-26b-a4b-it' || model === '@cf/zai-org/glm-4.7-flash') ? thinking : null,
    repeatRuns,
    batching: 'all answers in one request per run',
    officialPassageShownToModel: false,
    goldLabelsShownToModel: false
  },
  reproducibility: {
    casesSha256: sha256(JSON.stringify(casesData)),
    promptSha256: sha256(promptTemplate),
    promptChars: codePointLength(prompt)
  },
  goldStandard: casesData.goldStandard,
  runs
};

const safeModel = model.replace(/[^a-zA-Z0-9._-]+/g, '_');
const outDir = path.join(__dirname, 'results');
await fs.mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, `2024-grader-${safeModel}-${Date.now()}.json`);
await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
console.error(`Saved: ${outPath}`);

if (runs.some((run) => run.error)) process.exitCode = 1;
