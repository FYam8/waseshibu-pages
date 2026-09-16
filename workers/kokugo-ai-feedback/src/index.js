import { DurableObject } from 'cloudflare:workers';
import { PUBLIC_QUESTIONS, buildPrompt, parseModelText, validateGrade, validateSubmission } from './core.js';

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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function limits(env) {
  return {
    daily: Math.max(1, Number.parseInt(env.DAILY_REQUEST_LIMIT || '25', 10)),
    perIp: Math.max(1, Number.parseInt(env.PER_IP_DAILY_LIMIT || '3', 10)),
    output: Math.min(1000, Math.max(200, Number.parseInt(env.MAX_COMPLETION_TOKENS || '700', 10)))
  };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function ipHash(request) {
  const source = request.headers.get('CF-Connecting-IP') || 'local';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}

function extractText(result) {
  if (typeof result?.response === 'string') return result.response;
  const content = result?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part === 'string' ? part : part?.text || '').join('');
  return '';
}

async function grade(request, env) {
  if (!sameOrigin(request)) return json({ error: 'cross_origin_denied' }, 403);
  const size = Number(request.headers.get('content-length') || 0);
  if (size > 8192) return json({ error: 'request_too_large' }, 413);
  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const submission = validateSubmission(payload);
  if (!submission.ok) return json({ error: 'invalid_request', message: submission.error }, 400);

  const config = limits(env);
  const gate = env.USAGE_GATE.getByName(today());
  const reservation = await gate.reserve(await ipHash(request), config.daily, config.perIp);
  if (!reservation.allowed) return json({ error: 'rate_limited', reason: reservation.reason, quota: reservation }, 429);

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
    console.error(JSON.stringify({ event: 'ai_error', questionId: submission.question.id, error: String(error) }));
    return json({ error: 'ai_unavailable', message: 'AI判定を完了できませんでした。時間をおいてお試しください。' }, 503);
  }

  let result;
  try { result = parseModelText(extractText(aiResult)); } catch {
    console.error(JSON.stringify({ event: 'invalid_ai_json', questionId: submission.question.id }));
    return json({ error: 'invalid_ai_response', message: 'AI判定の形式を確認できませんでした。' }, 502);
  }
  const errors = validateGrade(result, submission.question);
  if (errors.length) {
    console.error(JSON.stringify({ event: 'invalid_ai_schema', questionId: submission.question.id, errors }));
    return json({ error: 'invalid_ai_response', message: 'AI判定の整合性を確認できませんでした。', details: errors }, 502);
  }
  const usage = aiResult?.usage ?? null;
  console.log(JSON.stringify({ event: 'graded', questionId: submission.question.id, verdict: result.verdict, latencyMs: Date.now() - started, neurons: usage?.neurons ?? null }));
  return json({
    result,
    meta: {
      model: env.MODEL,
      judgedOnce: true,
      latencyMs: Date.now() - started,
      usage,
      quota: { reservedRequests: reservation.total, dailyLimit: config.daily, remaining: reservation.remaining }
    }
  });
}

function page() {
  return new Response(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>国語AIフィードバック</title><style>
  :root{font-family:system-ui,sans-serif;color:#172033;background:#f5f1e8}*{box-sizing:border-box}body{margin:0}.wrap{max-width:820px;margin:auto;padding:28px 18px 60px}header{margin-bottom:22px}.eyebrow{font-size:12px;letter-spacing:.12em;color:#8a5c27;font-weight:700}h1{margin:.25em 0;font-size:clamp(28px,6vw,48px)}p{line-height:1.7}.card{background:#fff;border:1px solid #ded6c8;border-radius:18px;padding:20px;margin:14px 0;box-shadow:0 8px 25px #3b2c1710}label{display:block;font-weight:700;margin:14px 0 7px}select,textarea,input{width:100%;font:inherit;padding:12px;border:1px solid #bfb5a5;border-radius:10px;background:#fff}textarea{min-height:130px;resize:vertical}.parts{display:grid;grid-template-columns:1fr 1fr;gap:12px}button{border:0;border-radius:999px;padding:13px 22px;font-weight:700;background:#172033;color:#fff;cursor:pointer}button:disabled{opacity:.55;cursor:wait}.notice{font-size:13px;color:#62594d}.score{font-size:34px;font-weight:800}.tag{display:inline-block;padding:4px 10px;border-radius:999px;background:#efe5d3;margin-left:8px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.error{color:#9b2424}.usage{font-size:12px;color:#62594d}@media(max-width:620px){.grid,.parts{grid-template-columns:1fr}}
  </style></head><body><main class="wrap"><header><div class="eyebrow">WORKERS AI PILOT</div><h1>国語AIフィードバック</h1><p>公式模範解答と考え方を基準に、答案を一度だけ判定します。点数は公式採点ではなく学習上の参考です。</p></header><section class="card"><label for="question">問題</label><select id="question"></select><p id="questionText"></p><div id="answerFields"></div><p class="notice">答案は最大400字。1端末相当につき1日3回、全体で1日25回までです。</p><button id="grade">AIに判定してもらう</button><p id="status" aria-live="polite"></p></section><section class="card" id="result" hidden></section></main><script>
  let questions=[];const q=document.querySelector('#question'),fields=document.querySelector('#answerFields'),status=document.querySelector('#status'),result=document.querySelector('#result'),button=document.querySelector('#grade');
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function render(){const item=questions.find(x=>x.id===q.value);document.querySelector('#questionText').textContent=item.question;fields.innerHTML=item.parts?'<div class="parts">'+item.parts.map(p=>'<label>'+esc(p.id)+'（'+p.maxChars+'字以内）<input data-part="'+esc(p.id)+'" maxlength="400"></label>').join('')+'</div>':'<label>答案<textarea id="answer" maxlength="400" placeholder="答案を入力してください"></textarea></label>';result.hidden=true;status.textContent=''}
  function list(title,values){return '<div><b>'+title+'</b><p>'+((values||[]).map(esc).join('／')||'なし')+'</p></div>'}
  async function load(){const r=await fetch('/v1/questions');questions=(await r.json()).questions;q.innerHTML=questions.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.label)+'</option>').join('');render()}
  q.addEventListener('change',render);button.addEventListener('click',async()=>{const item=questions.find(x=>x.id===q.value);const answer=item.parts?Object.fromEntries([...fields.querySelectorAll('[data-part]')].map(x=>[x.dataset.part,x.value])):document.querySelector('#answer').value;button.disabled=true;status.textContent='判定中です…';result.hidden=true;try{const r=await fetch('/v1/grade',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({questionId:item.id,answer})});const data=await r.json();if(!r.ok)throw new Error(data.message||data.error);const g=data.result;result.innerHTML='<div class="score">'+g.referenceScore+' / '+g.maxScore+'<span class="tag">'+esc(g.verdict)+'</span></div><p>'+esc(g.referenceNotice)+'</p><div class="grid">'+list('認められる内容',g.contentAssessment.recognized)+list('不足している内容',g.contentAssessment.missing)+list('矛盾・誤り',g.contentAssessment.contradictions)+list('形式上の問題',g.constraintAssessment.issues)+'</div><h2>判定理由</h2><p>'+esc(g.explanation)+'</p><h2>改善点</h2><p>'+esc(g.improvementAdvice)+'</p><p class="usage">今回の使用量: '+esc(data.meta.usage?.total_tokens??'—')+' tokens / '+esc(data.meta.usage?.neurons??'—')+' neurons　残り予約枠: '+esc(data.meta.quota.remaining)+'</p>';result.hidden=false;status.textContent=''}catch(e){status.innerHTML='<span class="error">'+esc(e.message)+'</span>'}finally{button.disabled=false}});load().catch(()=>status.textContent='問題を読み込めませんでした。');
  </script></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') return page();
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, model: env.MODEL });
    if (request.method === 'GET' && url.pathname === '/v1/questions') return json({ questions: PUBLIC_QUESTIONS });
    if (request.method === 'GET' && url.pathname === '/v1/usage') {
      const config = limits(env);
      const gate = env.USAGE_GATE.getByName(today());
      return json({ dateUtc: today(), ...(await gate.status(config.daily)), freeAllocationNeuronsPerDay: 10000, note: 'reservedRequests is a protective request counter, not Cloudflare billing usage.' });
    }
    if (request.method === 'POST' && url.pathname === '/v1/grade') return grade(request, env);
    return json({ error: 'not_found' }, 404);
  }
};
