import { expect, test } from "@playwright/test";
import { openSaved, savedRun } from "./helpers/reports.mjs";

async function openPhoneResult(browser, baseURL) {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await openSaved(page, await savedRun(page));
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('.comparison-table tr[data-result-id="report-strategy"] .result-select').click();
  const chart = page.locator(".chart-panel.chart-overlay svg.result-chart");
  await chart.scrollIntoViewIfNeeded();
  return { context, page, chart, session: await context.newCDPSession(page) };
}

async function geometry(page, chart) {
  const bounds = await chart.boundingBox();
  return chart.evaluate((svg, box) => {
    const plot = svg.querySelector("clipPath rect");
    return {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      viewBoxWidth: svg.viewBox.baseVal.width,
      viewBoxHeight: svg.viewBox.baseVal.height,
      plotLeft: Number(plot.getAttribute("x")),
      plotTop: Number(plot.getAttribute("y")),
      plotWidth: Number(plot.getAttribute("width")),
      plotHeight: Number(plot.getAttribute("height")),
      viewportWidth: window.innerWidth,
    };
  }, bounds);
}

function point(box, plotFraction, yFraction = 0.5) {
  const visibleViewBoxX = Math.min(box.viewBoxWidth,
    ((box.viewportWidth - box.x - 10) / box.width) * box.viewBoxWidth);
  const maxVisibleFraction = Math.min(1, Math.max(0.05,
    (visibleViewBoxX - box.plotLeft) / box.plotWidth));
  const x = box.plotLeft + box.plotWidth * maxVisibleFraction * plotFraction;
  const y = box.plotTop + box.plotHeight * yFraction;
  return {
    x: Math.round(box.x + (x / box.viewBoxWidth) * box.width),
    y: Math.round(box.y + (y / box.viewBoxHeight) * box.height),
    maxVisibleFraction,
  };
}

async function touch(session, type, points = []) {
  await session.send("Input.dispatchTouchEvent", { type, touchPoints: points });
}

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test("phone chart supports pinch zoom and single-finger horizontal and vertical panning", async ({ browser, baseURL }) => {
  const { context, page, chart, session } = await openPhoneResult(browser, baseURL);
  const frame = await geometry(page, chart);
  const scale = await page.evaluate(() => window.visualViewport?.scale);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /initial-scale=1(?:\.0)?/);
  await expect(page.locator('meta[name="viewport"]')).not.toHaveAttribute("content", /maximum-scale|user-scalable/);
  await expect(chart).toHaveCSS("touch-action", "none");
  expect(scale).toBe(1);
  const legacyGesture = await page.evaluate(() => {
    const event = new Event("gesturestart", { bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(legacyGesture).toBe(true);
  await session.send("Input.synthesizePinchGesture", {
    x: 180,
    y: 24,
    scaleFactor: 1.8,
    relativeSpeed: 800,
    gestureSourceType: "touch",
  });
  await settle(page);
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);

  const reset = page.getByRole("button", { name: "全期間に戻す" });
  const zoomIn = page.getByRole("button", { name: "期間を拡大" });
  const initialStart = await page.locator(".chart-overlay").getAttribute("data-window-start");
  const initialEnd = await page.locator(".chart-overlay").getAttribute("data-window-end");
  const pinchStart = [point(frame, 0.12), point(frame, 0.78)];
  const pinchEnd = [point(frame, 0.03), point(frame, 0.96)];
  expect(pinchStart.every(item => item.x < frame.viewportWidth && item.y >= frame.y && item.y <= frame.y + frame.height)).toBe(true);
  await touch(session, "touchStart", pinchStart);
  await touch(session, "touchMove", pinchEnd);
  await settle(page);
  const pinchedStart = await page.locator(".chart-overlay").getAttribute("data-window-start");
  const pinchedEnd = await page.locator(".chart-overlay").getAttribute("data-window-end");
  expect(pinchedStart).not.toBe(initialStart);
  expect(Number(pinchedEnd) - Number(pinchedStart)).toBeLessThan(Number(initialEnd) - Number(initialStart));
  await touch(session, "touchEnd");
  await settle(page);
  const panelRanges = await page.locator(".chart-panel").evaluateAll(panels => panels.map(panel =>
    [panel.dataset.windowStart, panel.dataset.windowEnd]));
  expect(new Set(panelRanges.map(range => range.join(":")).values()).size).toBe(1);

  await reset.click();
  await zoomIn.click();
  const horizontalStart = Number(await page.locator(".chart-overlay").getAttribute("data-window-start"));
  const dragPoint = point(frame, 0.6);
  await touch(session, "touchStart", [dragPoint]);
  await touch(session, "touchMove", [{ ...dragPoint, x: dragPoint.x - 45 }]);
  await settle(page);
  const horizontalEnd = Number(await page.locator(".chart-overlay").getAttribute("data-window-start"));
  expect(horizontalEnd).toBeGreaterThan(horizontalStart);
  await touch(session, "touchEnd");

  await reset.click();
  const path = await chart.locator(".overlay-series-line").first().getAttribute("points");
  const verticalPoint = point(frame, 0.6, 0.5);
  await touch(session, "touchStart", [verticalPoint]);
  await touch(session, "touchMove", [{ ...verticalPoint, y: verticalPoint.y + 35 }]);
  await settle(page);
  await expect(chart.locator(".overlay-series-line").first()).not.toHaveAttribute("points", path);
  await touch(session, "touchEnd");
  await context.close();
});

test("one-second long press retains a linked crosshair; legacy chart modes are gone", async ({ browser, baseURL }) => {
  const { context, page, chart, session } = await openPhoneResult(browser, baseURL);
  const frame = await geometry(page, chart);
  const target = point(frame, 0.6, 0.52);
  const reading = page.locator(".chart-crosshair-readout");
  const beforeDate = await reading.getAttribute("data-date");

  await touch(session, "touchStart", [target]);
  await page.waitForTimeout(1100);
  await expect(page.locator(".chart-overlay .chart-crosshair")).toHaveCount(1);
  const heldDate = await reading.getAttribute("data-date");
  expect(heldDate).not.toBe(beforeDate);

  await touch(session, "touchMove", [{ ...target, x: target.x + 35 }]);
  await settle(page);
  const movedDate = await reading.getAttribute("data-date");
  expect(movedDate).not.toBe(heldDate);
  for (const crosshair of await page.locator(".chart-crosshair").all()) {
    await expect(crosshair).toHaveAttribute("data-date", movedDate);
  }
  await touch(session, "touchEnd");
  await expect(page.locator(".chart-overlay .chart-crosshair")).toHaveCount(1);
  await expect(page.locator(".chart-touch-controls, .chart-wheel-zoom-toggle, .chart-phone-advanced-controls")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /查看|平移|放大镜|滚轮缩放/ })).toHaveCount(0);
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  await context.close();
});
