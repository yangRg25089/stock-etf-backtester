import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { openSaved, savedRun } from './helpers/reports.mjs';
import { openTopbarMenu, selectHeaderLocale } from './helpers/runtime.mjs';

for (const locale of ['ja', 'zh', 'en']) for (const width of [320, 1440]) {
  test(`shared downloads produce strategy JSON, CSV and PNG in ${locale} at ${width}px`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const saved = await savedRun(page);
    await openSaved(page, saved);
    await page.setViewportSize({ width, height: 900 });
    await selectHeaderLocale(page, locale);
    const download = async selector => {
      const pending = page.waitForEvent('download');
      await page.locator(selector).click();
      const file = await pending;
      expect(await file.failure()).toBeNull();
      return { filename: file.suggestedFilename(), bytes: await readFile(await file.path()) };
    };
    await openTopbarMenu(page);
    const strategy = await download('.package-actions button:first-child');
    expect(strategy.filename).toMatch(/\.strategy\.json$/);
    expect(JSON.parse(strategy.bytes.toString()).format).toBe('stock-etf-backtester');
    if (width < 768) await page.locator('.topbar-menu-toggle').click();
    if (width < 768) await page.locator('.result-downloads-toggle').click();
    const csv = await download('[data-export-kind="summary"]');
    expect(csv.filename).toMatch(/\.csv$/);
    expect(csv.bytes.toString()).toContain('endingEquity');
    const png = await download('[data-report-kind="png"]');
    expect(png.filename).toMatch(/\.png$/);
    expect([...png.bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.bytes.length).toBeGreaterThan(1000);
    expect(errors).toEqual([]);
  });
}
