import { DurableObject } from 'cloudflare:workers';
import { PUBLIC_QUESTIONS, buildPrompt, isUsageLimitError, parseModelText, validateCustomSubmission, validateGrade, validateSubmission } from './core.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

export class UsageGate extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS usage (ip_hash TEXT PRIMARY KEY, requests INTEGER NOT NULL)');
  }

  reserve(ipHash, dailyLimit, perIpLimit) {
    const total = this.ctx.storage.sql.exec('SELECT COALESCE(SUM(requests), 0) AS total FROM usage').one().total;
    const row = this.ctx.storage.sql.exec('SELECT requests FROM usage WHERE ip_hash = ?', ipHash).toArray()[0];
    const perIp = Number(row?.requests ?? 0);
    if (Number(total) >= dailyLimit) return { allowed: false, reason: 'daily_limit', total: Number(total), remaining: 0 };
    if (perIp >= perIpLimit) return { allowed: false, reason: 'ip_limit', total: Number(total), remaining: Math.max(0, dailyLimit - Number(total)) };
    this.ctx.storage.sql.exec('INSERT INTO usage (ip_hash, requests) VALUES (?, 1) ON CONFLICT(ip_hash) DO UPDATE SET requests = requests + 1', ipHash);
    return { allowed: true, total: Number(total) + 1, remaining: Math.max(0, dailyLimit - Number(total) - 1) };
  }

  status(dailyLimit) {
    const total = Number(this.ctx.storage.sql.exec('SELECT COALESCE(SUM(requests), 0) AS total FROM usage').one().total);
    return { reservedRequests: total, dailyLimit, remaining: Math.max(0, dailyLimit - total) };
  }
}

const PUBLIC_APP_ORIGIN = 'https://fyam8.github.io';

function allowedOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  try {
    const parsed = new URL(origin).origin;
    if (parsed === PUBLIC_APP_ORIGIN || parsed === new URL(request.url).origin) return parsed;
  } catch {}
  return false;
}

function responseHeaders(request, base = {}) {
  const origin = allowedOrigin(request);
  return {
    ...base,
    ...(origin ? {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
      vary: 'Origin'
    } : {})
  };
}

function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: responseHeaders(request, JSON_HEADERS) });
}

function limits(env) {
  return {
    output: Math.min(1000, Math.max(200, Number.parseInt(env.MAX_COMPLETION_TOKENS || '700', 10)))
  };
}

function extractText(result) {
  if (typeof result?.response === 'string') return result.response;
  const content = result?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part === 'string' ? part : part?.text || '').join('');
  return '';
}

async function grade(request, env, validator = validateSubmission) {
  if (allowedOrigin(request) === false) return json(request, { error: 'cross_origin_denied' }, 403);
  const size = Number(request.headers.get('content-length') || 0);
  if (size > 8192) return json(request, { error: 'request_too_large' }, 413);
  let payload;
  try { payload = await request.json(); } catch { return json(request, { error: 'invalid_json' }, 400); }
  const submission = validator(payload);
  if (!submission.ok) return json(request, { error: 'invalid_request', message: submission.error }, 400);

  const config = limits(env);
  const started = Date.now();
  let aiResult;
  try {
    aiResult = await env.AI.run(env.MODEL || '@cf/google/gemma-4-26b-a4b-it', {
      messages: [{ role: 'user', content: buildPrompt(submission.question, submission.answer) }],
      temperature: 0,
      max_completion_tokens: config.output,
      reasoning_effort: 'low',
      chat_template_kwargs: { enable_thinking: false }
    });
  } catch (error) {
    if (isUsageLimitError(error)) {
      console.error(JSON.stringify({ event: 'ai_usage_limit', questionId: submission.question.id, error: String(error) }));
      return json(request, { error: 'usage_limit_reached', message: 'AIの利用上限に達しました。時間をおいてもう一度お試しください。' }, 429);
    }
    console.error(JSON.stringify({ event: 'ai_error', questionId: submission.question.id, error: String(error) }));
    return json(request, { error: 'ai_unavailable', message: 'AI判定を完了できませんでした。時間をおいてお試しください。' }, 503);
  }

  let result;
  try { result = parseModelText(extractText(aiResult)); } catch {
    console.error(JSON.stringify({ event: 'invalid_ai_json', questionId: submission.question.id }));
    return json(request, { error: 'invalid_ai_response', message: 'AI判定の形式を確認できませんでした。' }, 502);
  }
  const errors = validateGrade(result, submission.question);
  if (errors.length) {
    console.error(JSON.stringify({ event: 'invalid_ai_schema', questionId: submission.question.id, errors }));
    return json(request, { error: 'invalid_ai_response', message: 'AI判定の整合性を確認できませんでした。', details: errors }, 502);
  }
  const usage = aiResult?.usage ?? null;
  console.log(JSON.stringify({ event: 'graded', questionId: submission.question.id, verdict: result.verdict, latencyMs: Date.now() - started, neurons: usage?.neurons ?? null }));
  return json(request, {
    result,
    meta: {
      model: env.MODEL,
      judgedOnce: true,
      latencyMs: Date.now() - started,
      usage,
      limitPolicy: { applicationDailyLimit: null, applicationPerIpLimit: null, enforcedBy: 'cloudflare' }
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      if (allowedOrigin(request) === false) return json(request, { error: 'cross_origin_denied' }, 403);
      return new Response(null, { status: 204, headers: responseHeaders(request) });
    }
    if (request.method === 'GET' && url.pathname === '/') return Response.redirect('https://fyam8.github.io/waseshibu-pages/', 302);
    if (request.method === 'GET' && url.pathname === '/health') return json(request, { ok: true, model: env.MODEL });
    if (request.method === 'GET' && url.pathname === '/v1/questions') return json(request, { questions: PUBLIC_QUESTIONS });
    if (request.method === 'GET' && url.pathname === '/v1/usage') {
      return json(request, {
        applicationDailyLimit: null,
        applicationPerIpLimit: null,
        enforcedBy: 'cloudflare',
        note: 'アプリ独自の日次・IP別上限はありません。Cloudflare側の利用上限到達時は判定APIが429を返します。'
      });
    }
    if (request.method === 'POST' && url.pathname === '/v1/grade') return grade(request, env);
    if (request.method === 'POST' && url.pathname === '/v1/grade/custom') return grade(request, env, validateCustomSubmission);
    return json(request, { error: 'not_found' }, 404);
  }
};
