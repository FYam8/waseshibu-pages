const API_ORIGIN = 'https://waseshibu-kokugo-ai-feedback.fyam8.workers.dev';
const STORAGE_PREFIX = 'kokugo-ai-feedback:v1:';

const PAST_QUESTIONS = new Map([
  ['2022-2-6', '2022-2-6'],
  ['2023-2-2', '2023-2-2'],
  ['2024-2-6', '2024-2-6'],
  ['2025-1-6', '2025-1-6'],
  ['2026-2-4', '2026-2-4']
]);

export function pastQuestionId(year, label) {
  const match = String(label ?? '').match(/大問\s*(\d+)\s*問\s*(\d+)/);
  return match ? PAST_QUESTIONS.get(`${year}-${match[1]}-${match[2]}`) ?? null : null;
}

export function parseConstraints(text) {
  const value = String(text ?? '');
  return {
    minChars: Number(value.match(/(\d+)字以上/)?.[1] ?? 0),
    maxChars: Number(value.match(/(\d+)字以内/)?.[1] ?? 400),
    requiredWords: []
  };
}

export function cacheSource(kind, identity, answer) {
  return `${kind}\n${identity}\n${String(answer ?? '').trim()}`;
}

async function hash(value) {
  const data = new TextEncoder().encode(value);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function storageGet(key) {
  try { return JSON.parse(localStorage.getItem(STORAGE_PREFIX + key) || 'null'); } catch { return null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value)); } catch {}
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function feedbackList(title, values) {
  const section = element('section', 'ai-feedback-list');
  section.append(element('b', '', title));
  const list = element('ul');
  const items = Array.isArray(values) && values.length ? values : ['なし'];
  for (const value of items) list.append(element('li', '', value));
  section.append(list);
  return section;
}

function renderResult(host, response, fromCache = false) {
  const grade = response.result;
  host.replaceChildren();
  host.className = `ai-feedback-result ${grade.verdict}`;
  const labels = { correct: '内容を満たしています', partial: '一部を満たしています', incorrect: '見直しが必要です' };
  const head = element('div', 'ai-feedback-result-head');
  const verdict = element('div');
  verdict.append(element('span', 'ai-feedback-kicker', 'AIの内容判定'), element('strong', '', labels[grade.verdict] ?? grade.verdict));
  head.append(verdict, element('span', 'ai-feedback-score', `参考 ${grade.referenceScore} / ${grade.maxScore}点`));
  host.append(head);

  const explanation = element('section', 'ai-feedback-explanation');
  explanation.append(element('b', '', 'なぜこの判定か'), element('p', '', grade.explanation));
  host.append(explanation);

  const details = element('div', 'ai-feedback-details');
  details.append(
    feedbackList('認められる内容', grade.contentAssessment?.recognized),
    feedbackList('不足している内容', grade.contentAssessment?.missing),
    feedbackList('矛盾・誤り', grade.contentAssessment?.contradictions),
    feedbackList('形式上の問題', grade.constraintAssessment?.issues)
  );
  host.append(details);

  const advice = element('section', 'ai-feedback-advice');
  advice.append(element('b', '', '次に直すこと'), element('p', '', grade.improvementAdvice));
  host.append(advice);
  host.append(element('small', 'ai-feedback-notice', `${grade.referenceNotice}${fromCache ? '（保存済みの判定を表示）' : ''} AI判定は既存の得点・学習履歴を変更しません。`));
}

function friendlyError(data, status) {
  if (status === 429) return '本日のAI判定回数の上限に達しました。既存の採点機能はそのまま利用できます。';
  return data?.message || 'AI判定を完了できませんでした。時間をおいてお試しください。';
}

async function attachAction(host, { endpoint, payload, kind, identity, answer }) {
  const result = element('div', 'ai-feedback-result-host');
  const key = await hash(cacheSource(kind, identity, answer));
  const saved = storageGet(key);
  if (saved?.result) {
    renderResult(result, saved, true);
    host.append(result);
    return;
  }

  const box = element('section', 'ai-feedback-action');
  box.append(element('div', 'ai-feedback-kicker', 'AI FEEDBACK'));
  box.append(element('b', '', '模範解答と考え方を基準に、内容を1回だけ確認'));
  box.append(element('p', '', '本文全体は送信しません。点数は参考表示で、判定理由を中心に返します。'));
  const button = element('button', 'ai-feedback-button', 'AIの判定理由を見る（1回）');
  const status = element('p', 'ai-feedback-status');
  status.setAttribute('aria-live', 'polite');
  box.append(button, status);
  host.append(box, result);

  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = '模範解答と考え方に照らして確認しています…';
    try {
      const request = await fetch(`${API_ORIGIN}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await request.json().catch(() => ({}));
      if (!request.ok) throw new Error(friendlyError(data, request.status));
      storageSet(key, data);
      box.remove();
      renderResult(result, data);
    } catch (error) {
      status.textContent = error.message;
      status.classList.add('error');
      button.disabled = false;
    }
  }, { once: false });
}

function pastExamPayload(row, year) {
  const label = row.querySelector(':scope > div:first-child b')?.textContent ?? '';
  const questionId = pastQuestionId(year, label);
  const own = row.querySelector('.ownAnswer')?.textContent?.replace(/^答案：/, '').trim() ?? '';
  if (!questionId || !own || own.includes('（未回答）')) return null;
  return {
    endpoint: '/v1/grade', payload: { questionId, answer: own },
    kind: 'past', identity: questionId, answer: own
  };
}

function originalDrillPayload(panel) {
  const review = panel.closest('.mixedWrittenReview');
  const card = panel.closest('.focusedDrillCard');
  const question = (review?.querySelector(':scope > b') ?? card?.querySelector(':scope > h3'))?.textContent?.trim() ?? '';
  const comparison = panel.querySelectorAll('.writtenComparison section p');
  const answer = comparison[0]?.textContent?.trim() ?? review?.querySelector('textarea')?.value?.trim() ?? '';
  const referenceAnswer = comparison[1]?.textContent?.trim() ?? '';
  const answerRationale = panel.querySelector('.writtenExplanation')?.textContent?.trim() ?? '';
  const requiredElements = [...panel.querySelectorAll('.elementAssessmentRow > b')].map((node) => node.textContent.trim()).filter(Boolean);
  const constraintText = card?.querySelector('.focusedDrillTextAnswer small')?.textContent ?? review?.textContent ?? '';
  if (!question || !answer || !referenceAnswer || !answerRationale || !requiredElements.length) return null;
  return {
    endpoint: '/v1/grade/custom',
    payload: { question, answer, referenceAnswer, answerRationale, requiredElements, constraints: parseConstraints(constraintText) },
    kind: 'original', identity: question, answer
  };
}

function enhancePastExam() {
  const shell = document.querySelector('.scoreShell');
  const year = shell?.querySelector('.topbar h1')?.textContent?.match(/(20\d{2})年度/)?.[1];
  if (!shell || !year) return;
  for (const row of shell.querySelectorAll('.gradeRow:not([data-ai-feedback-checked])')) {
    row.dataset.aiFeedbackChecked = 'true';
    const config = pastExamPayload(row, year);
    if (!config) continue;
    const host = element('div', 'ai-feedback-host');
    row.append(host);
    attachAction(host, config);
  }
}

function enhanceOriginalDrills() {
  for (const panel of document.querySelectorAll('.writtenAssessmentPanel:not([data-ai-feedback-checked])')) {
    panel.dataset.aiFeedbackChecked = 'true';
    const config = originalDrillPayload(panel);
    if (!config) continue;
    const host = element('div', 'ai-feedback-host');
    panel.after(host);
    attachAction(host, config);
  }
}

let scheduled = false;
function enhance() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    enhancePastExam();
    enhanceOriginalDrills();
  });
}

if (typeof document !== 'undefined') {
  enhance();
  new MutationObserver(enhance).observe(document.documentElement, { childList: true, subtree: true });
}

