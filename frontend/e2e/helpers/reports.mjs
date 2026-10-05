import { installRunFixture } from "./runtime.mjs";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

export function strategyForRequest(catalog, presetId, params = {}, editRules = () => {}) {
  const preset = catalog.presets.find(item => item.id === presetId);
  const numericKeys = new Set(catalog.parameters.filter(item => ["decimal", "integer", "ratio", "percent_point"].includes(item.type)).map(item => item.key));
  const numericListKeys = new Set(catalog.parameters.filter(item => item.type === "number_list").map(item => item.key));
  const numericParams = object => Object.fromEntries(Object.entries(object).map(([key, value]) => [key,
    numericKeys.has(key) && value !== null ? Number(value) : numericListKeys.has(key) ? value.map(Number) : value]));
  const rules = structuredClone(preset.defaultRules);
  const wireRules = node => {
    if (!node) return;
    if (node.kind) node.params = numericParams(node.params ?? {});
    else (node.children ?? []).forEach(wireRules);
  };
  wireRules(rules?.buy); wireRules(rules?.sell); editRules(rules);
  return { presetId, params: numericParams({ ...preset.defaultParams, ...params }), rules };
}

export async function savedRun(page, presetId = "vix_dca", params = {}, editRules = () => {}, shared = {}) {
  const catalog = await (await page.request.get("/api/v1/catalog")).json();
  const response = await page.request.post("/api/v1/runs", {
    headers: { "Idempotency-Key": `report-${presetId}-${Date.now()}` },
    data: { draft: {
      shared: { contribution: { amount: 100, day: 1 }, ...shared, run: { symbol: "QQQ", startDate: "2024-02-01", endDate: "2024-03-01", ...shared.run } },
      strategies: [{ id: "report-strategy", ...strategyForRequest(catalog, presetId, params, editRules) }],
    }, scope: "all_enabled" },
  });
  expect(response.status()).toBe(202);
  const { runId } = await response.json();
  let saved;
  await expect.poll(async () => {
    saved = await (await page.request.get(`/api/v1/runs/${runId}`)).json();
    if (/^completed(?:_with_warning)?$/.test(saved.status)) return saved.status;
    const errors = (saved.result?.strategyRuns ?? []).map(row => `${row.id}: ${(row.diagnostics ?? []).map(item => item.messageKey).join(",")}`).join("; ");
    return `${saved.status} ${errors}`;
  }).toMatch(/^completed(?:_with_warning)?$/);
  const primary = saved.result.strategyRuns.find(row => row.id === "report-strategy");
  expect(primary.status, JSON.stringify(primary.diagnostics)).toMatch(/^completed(?:_with_warning)?$/);
  return saved;
}

export async function openSaved(page, saved) {
  await installRunFixture(page, saved);
  await page.addInitScript(() => {
    window.reportAudit = { text: [], bitmaps: [], downloads: 0, revoked: 0 };
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      window.reportAudit.text.push(args[0]); return fillText.apply(this, args);
    };
    const encode = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (...args) {
      window.reportAudit.bitmaps.push([this.width, this.height]); return encode.apply(this, args);
    };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download.endsWith(".png")) window.reportAudit.downloads++;
      return click.call(this);
    };
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = function (url) { window.reportAudit.revoked++; return revoke.call(this, url); };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".comparison-table tbody tr")).toHaveCount(3);
  await expect(page.locator(".result-interactions")).not.toBeDisabled();
}

export async function pngDownload(page, name, minWidth = 1000) {
  const waiting = page.waitForEvent("download");
  await page.locator("[data-report-kind=png]").click();
  const download = await waiting;
  expect(download.suggestedFilename()).toMatch(/^QQQ-.*\.png$/);
  const path = test.info().outputPath(name);
  await download.saveAs(path);
  const bytes = await readFile(path);
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  expect(width).toBeGreaterThan(minWidth);
  expect(width).toBeLessThanOrEqual(16384);
  expect(height).toBeGreaterThan(1200);
  expect(width * height).toBeLessThanOrEqual(16_000_000);
  expect(height).toBeLessThanOrEqual(16384);
  return download;
}
