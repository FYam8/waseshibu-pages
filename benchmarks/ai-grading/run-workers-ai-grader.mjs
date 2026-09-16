#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_AUTH_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
const model = process.env.WORKERS_AI_MODEL || '@cf/google/gemma-4-26b-a4b-it';
const repeatRuns = Number(process.env.BENCH_REPEAT || 1);
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

const casesPath = process.env.GRADER_CASES_PATH
  ? path.resolve(process.env.GRADER_CASES_PATH)
  : path.join(__dirname, '2022-2026', 'grader-cases-v2.json');
const promptPath = process.env.GRADER_PROMPT_PATH
  ? path.resolve(process.env.GRADER_PROMPT_PATH)
  : path.join(__dirname, 'prompts', 'grader-v2.txt');
const casesData = JSON.parse(await fs.readFile(casesPath, 'utf8'));
const promptTemplate = await fs.readFile(promptPath, 'utf8');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function codePointLength(value) {
  return [...String(value ?? '').trim()].length;
}

function mechanicalChecks(question, answer) {
  const requiredWords = question.constraints?.requiredWords ?? [];
  if (question.answerFormat === 'parts') {
    const parts = Object.fromEntries((question.parts ?? []).map((part) => {
      const value = answer?.[part.id] ?? '';
      const charCount = codePointLength(value);
      return [part.id, {
        charCount,
        maxChars: part.maxChars,
        withinLimit: typeof part.maxChars !== 'number' || charCount <= part.maxChars,
        present: charCount > 0,
        requiredForm: part.requiredForm ?? null,
      }];
    }));
    return { parts, requiredWords: [] };
  }

  const charCount = codePointLength(answer);
  return {
    charCount,
    maxChars: question.constraints?.maxChars ?? null,
    withinLimit: typeof question.constraints?.maxChars !== 'number'
      || charCount <= question.constraints.maxChars,
    present: charCount > 0,
    requiredWords: requiredWords.map((word) => ({ word, present: String(answer).includes(word) })),
  };
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
    scorePolicy: casesData.evaluationPolicy,
    questions: casesData.questions.map((question) => ({
      id: question.id,
      year: question.year,
      question: question.question,
      maxScore: question.maxScore,
      answerFormat: question.answerFormat,
      answerFrame: question.answerFrame,
      parts: question.parts,
      referenceAnswer: question.referenceAnswer,
      answerRationale: question.answerRationale,
      constraints: question.constraints,
      answers: question.answers.map(({ id, answer }) => ({
        answerId: id,
        answer,
        mechanicalChecks: mechanicalChecks(question, answer),
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
    verdict: answer.expectedVerdict,
    partVerdicts: answer.expectedPartVerdicts ?? null,
    maxScore: question.maxScore,
    partIds: question.parts?.map((part) => part.id) ?? [],
  }])));
}

function validateResult(actual, expected) {
  const errors = [];
  if (!actual || typeof actual !== 'object') return ['result is missing'];
  if (!Number.isInteger(actual.referenceScore)) errors.push('referenceScore must be an integer');
  if (actual.referenceScore < 0 || actual.referenceScore > expected.maxScore) {
    errors.push('referenceScore is outside 0..maxScore');
  }
  if (actual.maxScore !== expected.maxScore) errors.push('maxScore does not match input');
  if (!['correct', 'partial', 'incorrect'].includes(actual.verdict)) errors.push('invalid verdict');
  for (const field of ['explanation', 'improvementAdvice', 'referenceNotice']) {
    if (typeof actual[field] !== 'string' || !actual[field].trim()) errors.push(`${field} is missing`);
  }
  for (const field of ['recognized', 'missing', 'contradictions']) {
    if (!Array.isArray(actual.contentAssessment?.[field])) errors.push(`contentAssessment.${field} must be an array`);
  }
  if (typeof actual.constraintAssessment?.compliant !== 'boolean') {
    errors.push('constraintAssessment.compliant must be boolean');
  }
  if (!Array.isArray(actual.constraintAssessment?.issues)) {
    errors.push('constraintAssessment.issues must be an array');
  }
  for (const partId of expected.partIds) {
    const part = actual.partAssessments?.[partId];
    if (!part) {
      errors.push(`partAssessments.${partId} is missing`);
      continue;
    }
    if (!['correct', 'partial', 'incorrect'].includes(part.verdict)) {
      errors.push(`partAssessments.${partId}.verdict is invalid`);
    }
  }
  return errors;
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
      .every(([part, label]) => actual?.partAssessments?.[part]?.verdict === label);
    const schemaErrors = validateResult(actual, gold);
    comparisons.push({
      answerId,
      expected: gold.verdict,
      actual: actual?.verdict ?? null,
      referenceScore: actual?.referenceScore ?? null,
      verdictMatch,
      partMatch,
      schemaErrors,
    });
  }
  return {
    total: comparisons.length,
    exactVerdicts: comparisons.filter((item) => item.verdictMatch).length,
    exactParts: comparisons.filter((item) => item.partMatch).length,
    schemaValid: comparisons.filter((item) => item.schemaErrors.length === 0).length,
    missingOrExtraIds: returned.length !== expected.size || comparisons.some((item) => item.actual === null),
    comparisons,
  };
}

const gradingInput = publicInput();
const prompt = promptTemplate.replace('{{GRADING_INPUT}}', JSON.stringify(gradingInput));

if (dryRun) {
  const answerCount = casesData.questions.reduce((total, question) => total + question.answers.length, 0);
  const mockResults = casesData.questions.flatMap((question) => question.answers.map((answer) => ({
    answerId: answer.id,
    referenceScore: answer.expectedVerdict === 'correct'
      ? question.maxScore
      : answer.expectedVerdict === 'incorrect' ? 0 : Math.max(1, Math.floor(question.maxScore / 2)),
    maxScore: question.maxScore,
    verdict: answer.expectedVerdict,
    ...(question.parts ? {
      partAssessments: Object.fromEntries(question.parts.map((part) => [part.id, {
        verdict: answer.expectedPartVerdicts?.[part.id] ?? answer.expectedVerdict,
        recognized: [],
        missing: [],
        contradictions: [],
      }])),
    } : {}),
    contentAssessment: { recognized: [], missing: [], contradictions: [] },
    constraintAssessment: { compliant: true, issues: [] },
    explanation: 'dry-run schema validation',
    improvementAdvice: 'dry-run schema validation',
    referenceNotice: 'この点数はAIによる参考評価であり、公式採点ではありません。',
  })));
  const selfTest = score({ results: mockResults });
  if (
    selfTest.exactVerdicts !== answerCount
    || selfTest.exactParts !== answerCount
    || selfTest.schemaValid !== answerCount
    || selfTest.missingOrExtraIds
  ) {
    throw new Error(`Dry-run schema self-test failed: ${JSON.stringify(selfTest)}`);
  }
  console.log(JSON.stringify({
    valid: true,
    questionCount: casesData.questions.length,
    answerCount,
    years: casesData.years,
    promptChars: codePointLength(prompt),
    expectedLabelsIncludedInPrompt: prompt.includes('expectedVerdict') || prompt.includes('expectedPartVerdicts'),
    officialPassageShownToModel: false,
    schemaSelfTest: {
      exactVerdicts: selfTest.exactVerdicts,
      exactParts: selfTest.exactParts,
      schemaValid: selfTest.schemaValid,
    },
  }, null, 2));
  process.exit(0);
}

async function runOne(run) {
  const input = {
    messages: [{ role: 'user', content: prompt }],
    temperature,
    reasoning_effort: reasoningEffort,
    max_completion_tokens: 5000,
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
  console.error(`Running five-year compact grader batch (${run}/${repeatRuns}) on ${model}...`);
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
  schemaVersion: 2,
  benchmark: casesData.benchmark,
  years: casesData.years,
  createdAt: new Date().toISOString(),
  model,
  settings: {
    temperature,
    reasoningEffort,
    maxCompletionTokens: 5000,
    thinking: (
      model === '@cf/google/gemma-4-26b-a4b-it'
      || model === '@cf/qwen/qwen3.8-27b'
      || model === '@cf/zai-org/glm-4.7-flash'
    ) ? thinking : null,
    repeatRuns,
    batching: 'each answer is judged once within one request per run',
    officialPassageShownToModel: false,
    goldLabelsShownToModel: false
  },
  reproducibility: {
    casesSha256: sha256(JSON.stringify(casesData)),
    promptSha256: sha256(promptTemplate),
    promptChars: codePointLength(prompt)
  },
  evaluationPolicy: casesData.evaluationPolicy,
  runs
};

const safeModel = model.replace(/[^a-zA-Z0-9._-]+/g, '_');
const outDir = path.join(__dirname, 'results');
await fs.mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, `2022-2026-grader-v2-${safeModel}-${Date.now()}.json`);
await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
console.error(`Saved: ${outPath}`);

if (runs.some((run) => run.error)) process.exitCode = 1;
