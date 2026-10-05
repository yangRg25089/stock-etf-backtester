import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { signalLabel } = require("../.test-output/features/results/tradeSignalLabel.js");

test("condition-scoped signals resolve to their actual translated condition label", () => {
  assert.equal(signalLabel("zh", "vix.buy:buy-vix"), "波动率买入信号");
  assert.equal(signalLabel("ja", "vix.buy:buy-vix"), "指数買付シグナル");
  assert.equal(signalLabel("en", "vix.buy:buy-vix"), "Index buy signal");
});

test("condition-scoped VIX exit tiers retain their staged sell label", () => {
  assert.equal(signalLabel("zh", "vix.exit:sell-vix.low1"), "波动率分档卖出 1");
  assert.equal(signalLabel("ja", "vix.exit:sell-vix.low2"), "指数段階売却 2");
  assert.equal(signalLabel("en", "vix.exit.low1"), "Index staged sell 1");
});

test("non-condition trades without a signal remain unlabeled", () => {
  assert.equal(signalLabel("zh", null), "—");
});
