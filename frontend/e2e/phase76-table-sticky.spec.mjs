import { expect, test } from "@playwright/test";
import { openSaved, savedRun } from "./helpers/reports.mjs";

async function longTables(page) {
  const saved = await savedRun(page);
  const result = saved.result.strategyRuns[0];
  const analysis = result.metrics.analysis;
  analysis.monthlyReturns = Array.from({ length: 48 * 12 }, (_, index) => {
    const year = 1978 + Math.floor(index / 12), month = index % 12 + 1, prefix = `${year}-${String(month).padStart(2, "0")}`;
    return { year, month, startDate: `${prefix}-01`, endDate: `${prefix}-28`, navReturn: "0.01", priceReturn: "0.02" };
  });
  analysis.annualReturns = Array.from({ length: 48 }, (_, index) => ({ year: 1978 + index,
    startDate: `${1978 + index}-01-01`, endDate: `${1978 + index}-12-31`, navReturn: "0.03", priceReturn: "0.04" }));
  analysis.drawdownEpisodes = Array.from({ length: 48 }, (_, index) => {
    const year = 1978 + index, peakDate = `${year}-02-01`, bottomDate = `${year}-02-02`, endDate = `${year}-03-01`;
    const days = (start, end) => (Date.parse(end) - Date.parse(start)) / 86400000;
    return { peakDate, bottomDate, endDate, recoveredDate: endDate, drawdown: "-0.1", durationDays: days(peakDate, endDate), recoveryDays: days(bottomDate, endDate), state: "recovered" };
  });
  result.trades = Array.from({ length: 80 }, () => ({ date: "2024-02-02", side: "buy", reason: "fixed_dca", quantity: "1", price: "1", cashAmount: "1", currency: "USD" }));
  await openSaved(page, saved);
}

for (const width of [375, 1440]) for (const selector of [".heatmap-table", ".trade-table", ".drawdown-episodes-table"]) {
  test(`${width}px ${selector} keeps its corner heading above rows during vertical and horizontal scrolling`, async ({ page }) => {
    await longTables(page);
    await page.setViewportSize({ width, height: 900 });
    const table = page.locator(selector);
    const scroller = table.locator('xpath=ancestor::div[contains(@class,"data-table-scroll")][1]');
    await scroller.scrollIntoViewIfNeeded();
    for (const left of [0, 120]) {
      await scroller.evaluate((node, scrollLeft) => { node.scrollTop = 130; node.scrollLeft = scrollLeft; }, left);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const probe = await scroller.evaluate(node => {
        const table = node.querySelector("table"), corner = table.tHead.rows[0].cells[0];
        const bounds = node.getBoundingClientRect(), head = corner.getBoundingClientRect();
        const x = bounds.left + 2 + Math.min(head.width / 2, node.clientWidth / 2), y = bounds.top + 2 + head.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { top: head.top, expectedTop: bounds.top + node.clientTop, headingOnTop: hit?.closest("thead") === table.tHead, hit: hit?.outerHTML.slice(0, 180) };
      });
      expect(probe.top).toBeCloseTo(probe.expectedTop, 0);
      expect(probe.headingOnTop, JSON.stringify(probe)).toBe(true);
    }
    const region = table.locator('xpath=ancestor::*[contains(@class,"table-height-region") or contains(@class,"performance-group")][1]');
    await region.locator(".table-expand-button").click();
    await table.evaluate(table => {
      const root = document.querySelector(".workbench-results");
      const top = table.getBoundingClientRect().top;
      if (getComputedStyle(root).overflowY === "auto") root.scrollTop += top - root.getBoundingClientRect().top + 120;
      else window.scrollBy(0, top - document.querySelector(".app-topbar").getBoundingClientRect().bottom + 120);
    });
    await expect.poll(async () => region.evaluate(region => {
      const table = region.querySelector("table"), corner = table.tHead.rows[0].cells[0];
      const controls = region.querySelector(".table-height-controls, .performance-group-heading").getBoundingClientRect();
      return Math.abs(corner.getBoundingClientRect().top - controls.bottom);
    })).toBeLessThanOrEqual(1);
    for (const left of [0, 120]) {
      await region.locator(".table-expanded-overflow").evaluate((node, left) => { node.scrollLeft = left; }, left);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const probes = await table.evaluate(table => {
        const frame = table.closest(".table-expanded-overflow").getBoundingClientRect();
        return [...table.tHead.rows[0].cells].flatMap(cell => {
          const box = cell.getBoundingClientRect(), left = Math.max(box.left, frame.left + 2), right = Math.min(box.right, frame.right - 2);
          if (right <= left) return [];
          const hit = document.elementFromPoint((left + right) / 2, box.top + box.height / 2);
          return [{ label: cell.textContent, headingOnTop: hit?.closest("thead") === table.tHead, hit: hit?.outerHTML.slice(0, 160), position: getComputedStyle(cell).position, z: getComputedStyle(cell).zIndex }];
        });
      });
      expect(probes.every(probe => probe.headingOnTop), JSON.stringify(probes)).toBe(true);
    }
  });
}
