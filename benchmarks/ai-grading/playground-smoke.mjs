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
      text: (el.innerText || el.textContent || '').trim().slice(0, 500),
      role: el.getAttribute('role'),
    })));
  const report = {
    url: page.url(),
    title: await page.title(),
    bodyText,
    controls,
    diagnostics: [...diagnostics],
  };
  await fs.writeFile(new URL(`${name}.json`, outDir), JSON.stringify(report, null, 2));
  await page.screenshot({ path: path.join(new URL('.', outDir).pathname, `${name}.png`), fullPage: true });
  console.log(`--- ${name.toUpperCase()} URL ---`);
  console.log(report.url);
  console.log(`--- ${name.toUpperCase()} BODY ---`);
  console.log(bodyText);
  console.log(`--- ${name.toUpperCase()} CONTROLS ---`);
  console.log(JSON.stringify(controls, null, 2));
  return report;
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(4_000);
  await snapshot('playground-home');

  const modelMode = page.getByText('Model mode', { exact: true }).first();
  await modelMode.click({ timeout: 15_000 });
  await page.waitForTimeout(5_000);
  await snapshot('playground-model-mode');

  console.log('--- DIAGNOSTICS ---');
  console.log(diagnostics.join('\n'));
} finally {
  await browser.close();
}
