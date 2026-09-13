#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const MODEL = '@cf/google/gemma-4-26b-a4b-it';
const url = `https://playground.ai.cloudflare.com/?model=${encodeURIComponent(MODEL)}`;
const outDir = new URL('./results/', import.meta.url);
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'ja-JP',
  viewport: { width: 1440, height: 1200 },
});
const page = await context.newPage();

const diagnostics = [];
page.on('console', (msg) => diagnostics.push(`[console:${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => diagnostics.push(`[pageerror] ${err.message}`));
page.on('websocket', (ws) => diagnostics.push(`[websocket] ${ws.url()}`));
page.on('requestfailed', (req) => diagnostics.push(`[requestfailed] ${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}`));

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(8_000);
  const title = await page.title();
  const bodyText = (await page.locator('body').innerText()).slice(0, 30_000);
  const inputs = await page.locator('input, textarea, [contenteditable="true"], button').evaluateAll((els) =>
    els.slice(0, 200).map((el) => ({
      tag: el.tagName,
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      ariaLabel: el.getAttribute('aria-label'),
      placeholder: el.getAttribute('placeholder'),
      text: (el.innerText || el.textContent || '').trim().slice(0, 300),
      role: el.getAttribute('role'),
    })),
  );

  const report = {
    url,
    title,
    bodyText,
    controls: inputs,
    diagnostics,
  };
  await fs.writeFile(new URL('playground-smoke.json', outDir), JSON.stringify(report, null, 2));
  await page.screenshot({ path: path.join(new URL('.', outDir).pathname, 'playground-smoke.png'), fullPage: true });

  console.log(`TITLE: ${title}`);
  console.log('--- BODY ---');
  console.log(bodyText);
  console.log('--- CONTROLS ---');
  console.log(JSON.stringify(inputs, null, 2));
  console.log('--- DIAGNOSTICS ---');
  console.log(diagnostics.join('\n'));
} finally {
  await browser.close();
}
