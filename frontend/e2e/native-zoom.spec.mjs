import { chromium, expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Use Chromium's native tab zoom in a disposable profile, not CSS zoom,
// viewport resizing, device-scale emulation, or a personal Chrome session.
test('native browser zoom at 100, 125 and 150 percent keeps the saved workbench usable', async ({ baseURL }) => {
  const directory = await mkdtemp(join(tmpdir(), 'backtester-native-zoom-'));
  const extension = join(directory, 'extension');
  await mkdir(extension);
  await writeFile(join(extension, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Local workbench zoom verification', version: '1.0',
    permissions: ['tabs'], background: { service_worker: 'background.js' },
  }));
  await writeFile(join(extension, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  let context;
  try {
    context = await chromium.launchPersistentContext(join(directory, 'profile'), {
      channel: 'chromium', headless: true, viewport: null,
      args: ['--window-size=1920,1080', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const page = context.pages()[0];
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(baseURL);
    await page.locator('.shared-settings-open-button').click();
    await page.getByLabel('開始日').fill('2024-01-31');
    await page.locator('#field-run-endDate').fill('2024-03-01');
    await page.locator('.shared-settings-dialog .dialog-done').click();
    await page.locator('.run-submit-button').click();
    await expect(page.locator('.chart-overlay .result-chart')).toBeVisible();
    const baseline = await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio }));
    const measurements = [];
    for (const factor of [1, 1.25, 1.5]) {
      const actual = await worker.evaluate(async (zoom) => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        await chrome.tabs.setZoom(tab.id, zoom);
        return chrome.tabs.getZoom(tab.id);
      }, factor);
      expect(actual).toBe(factor);
      await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBeCloseTo(baseline.dpr * factor, 2);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = await page.evaluate(() => {
        const panel = document.querySelector('.workbench-results').getBoundingClientRect();
        const svg = document.querySelector('.chart-overlay .result-chart');
        const plot = svg.querySelector('clipPath rect');
        const svgBounds = svg.getBoundingClientRect();
        const svgScale = svgBounds.height / svg.viewBox.baseVal.height;
        const top = svgBounds.top + Number(plot.getAttribute('y')) * svgScale;
        const bottom = top + Number(plot.getAttribute('height')) * svgScale;
        return {
          width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport.scale,
          documentHeight: document.documentElement.scrollHeight, documentWidth: document.documentElement.scrollWidth,
          visiblePlot: Math.min(bottom, panel.bottom) - Math.max(top, panel.top),
          plotTop: top, plotBottom: bottom, panelBottom: panel.bottom, resultsScroll: document.querySelector(".workbench-results").scrollTop,
          tableHeight: document.querySelector(".comparison-table").getBoundingClientRect().height,
          axisPixelHeight: svg.querySelector(".chart-y-tick").getBoundingClientRect().height * devicePixelRatio,
          ordinaryPixelFont: parseFloat(getComputedStyle(document.querySelector(".strategy-navigator h2")).fontSize) * devicePixelRatio,
          toolsHeight: document.querySelector(".chart-toolbar").getBoundingClientRect().height,
          layout: Object.fromEntries([".app-topbar", "#result-details", "#result-strategy-details", "#result-strategy-details .result-tabs", "#result-strategy-details .result-tab-panel", "#result-chart-panel", ".chart-toolbar", ".chart-overlay", ".result-chart"].map(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return [selector, {top:r.top,height:r.height}]; })),
        };
      });
      measurements.push({ factor, actual, ...geometry });
      expect(geometry.width * factor).toBeCloseTo(baseline.width, 0);
      expect(geometry.scale).toBe(1);
      const first = measurements[0];
      expect(geometry.axisPixelHeight / first.axisPixelHeight).toBeCloseTo(factor, 1);
      expect(geometry.axisPixelHeight / geometry.ordinaryPixelFont).toBeCloseTo(first.axisPixelHeight / first.ordinaryPixelFont, 1);
      expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.width);
      expect(geometry.documentHeight).toBeLessThanOrEqual(geometry.height + 1);
      expect(geometry.visiblePlot, JSON.stringify(measurements, null, 2)).toBeGreaterThan(factor === 1 ? 280 : 120);
      const toggle = page.locator('.workbench-config-toggle');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await page.locator('.strategy-card-open').first().click();
      await expect(page.locator('.strategy-dialog')).toBeVisible();
      await page.locator('.strategy-dialog .dialog-done').click();
      const report = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(report.violations).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`native-zoom-${factor}.png`), fullPage: true });
    }
    expect(errors).toEqual([]);
    await test.info().attach('native-zoom-geometry', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
  } finally {
    await context?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
