#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const MODEL = '@cf/google/gemma-4-26b-a4b-it';
const modelUrl = `https://playground.ai.cloudflare.com/models?model=${encodeURIComponent(MODEL)}`;
const outDir = new URL('./results/', import.meta.url);
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'ja-JP',
  viewport: { width: 1440, height: 1200 },
});
const page = await context.newPage();

const diagnostics = [];
const network = [];
const websocketFrames = [];
page.on('console', (msg) => diagnostics.push(`[console:${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => diagnostics.push(`[pageerror] ${err.message}`));
page.on('requestfailed', (req) => diagnostics.push(`[requestfailed] ${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}`));
page.on('websocket', (ws) => {
  diagnostics.push(`[websocket] ${ws.url()}`);
  ws.on('framesent', (event) => {
    const payload = typeof event.payload === 'string'
      ? event.payload.slice(0, 100000)
      : `<binary:${event.payload?.byteLength ?? 0}>`;
    websocketFrames.push({ direction: 'sent', url: ws.url(), payload });
  });
  ws.on('framereceived', (event) => {
    const payload = typeof event.payload === 'string'
      ? event.payload.slice(0, 100000)
      : `<binary:${event.payload?.byteLength ?? 0}>`;
    websocketFrames.push({ direction: 'received', url: ws.url(), payload });
  });
});
page.on('request', (req) => {
  if (req.method() !== 'GET') {
    const headers = req.headers();
    network.push({
      phase: 'request',
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      contentType: headers['content-type'] ?? null,
      postData: req.postData()?.slice(0, 20000) ?? null,
    });
  }
});
page.on('response', async (res) => {
  const req = res.request();
  if (req.method() !== 'GET') {
    network.push({
      phase: 'response',
      method: req.method(),
      url: res.url(),
      status: res.status(),
      contentType: (await res.allHeaders())['content-type'] ?? null,
    });
  }
});

async function snapshot(name) {
  const bodyText = (await page.locator('body').innerText()).slice(0, 40_000);
  const controls = await page
    .locator('a, input, textarea, [contenteditable="true"], button, [role="button"], [role="combobox"]')
    .evaluateAll((els) => els.slice(0, 300).map((el) => ({
      tag: el.tagName,
      type: el.getAttribute('type'),
      href: el.getAttribute('href'),
      name: el.getAttribute('name'),
      ariaLabel: el.getAttribute('aria-label'),
      placeholder: el.getAttribute('placeholder'),
      value: 'value' in el ? String(el.value ?? '').slice(0, 500) : null,
      text: (el.innerText || el.textContent || '').trim().slice(0, 500),
      role: el.getAttribute('role'),
    })));
  const report = {
    url: page.url(),
    title: await page.title(),
    bodyText,
    controls,
    diagnostics: [...diagnostics],
    network: [...network],
    websocketFrames: [...websocketFrames],
  };
  await fs.writeFile(new URL(`${name}.json`, outDir), JSON.stringify(report, null, 2));
  await page.screenshot({ path: path.join(new URL('.', outDir).pathname, `${name}.png`), fullPage: true });
  console.log(`--- ${name.toUpperCase()} BODY ---`);
  console.log(bodyText);
  return report;
}

try {
  await page.goto(modelUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(5_000);
  await snapshot('playground-model-mode');

  const prompt = '日本語で「OK」とだけ答えてください。';
  const textarea = page.locator('textarea[placeholder="Ask anything..."]');
  await textarea.fill(prompt);
  await page.getByRole('button', { name: 'Send message' }).click();

  const stop = page.getByRole('button', { name: 'Stop' });
  await stop.waitFor({ state: 'visible', timeout: 15_000 });
  await stop.waitFor({ state: 'hidden', timeout: 180_000 });
  await page.waitForTimeout(1_500);

  const completed = await snapshot('playground-after-smoke-prompt');
  if (!completed.bodyText.includes('OK')) {
    throw new Error('Smoke response did not contain OK.');
  }

  console.log('--- WEBSOCKET FRAMES ---');
  console.log(JSON.stringify(websocketFrames, null, 2));
} finally {
  await browser.close();
}
