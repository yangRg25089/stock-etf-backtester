import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { marketDateRecovery, applyMarketDateRecovery } = require("../.test-output/features/runs/dateRecovery.js");
const diagnostic = {
  code: "required_data_unavailable", messageKey: "market.period_before_listing", fieldPath: "run.startDate",
  details: { symbol: "SOXQ", availableFrom: "2021-06-11", requestedStartDate: "2020-01-01", requestedEndDate: "2020-12-31",
    suggestedStartDate: "2021-06-11", suggestedEndDate: "2026-10-02" },
};
const shared = { run: { symbol: "SOXQ", startDate: "2020-01-01", endDate: "2020-12-31" },
  contribution: { amount: "100", day: 1 }, currency: "USD" };

test("date recovery applies only verified server suggestions to the matching draft", () => {
  const recovery = marketDateRecovery(diagnostic);
  assert.equal(recovery.availableFrom, "2021-06-11");
  const updated = applyMarketDateRecovery(shared, recovery);
  assert.equal(updated.run.startDate, "2021-06-11");
  assert.equal(updated.run.endDate, "2026-10-02");
  assert.equal(updated.contribution, shared.contribution);
  assert.equal(updated.currency, "USD");
  assert.equal(shared.run.startDate, "2020-01-01");
  assert.equal(applyMarketDateRecovery(updated, recovery), updated);
  const edited = { ...shared, run: { ...shared.run, endDate: "2023-12-31" } };
  assert.equal(applyMarketDateRecovery(edited, recovery), edited);
  const another = { ...shared, run: { ...shared.run, symbol: "QQQ" } };
  assert.equal(applyMarketDateRecovery(another, recovery), another);
});

test("recovery never guesses dates or hides unrelated provider failures", () => {
  assert.equal(marketDateRecovery({ ...diagnostic, messageKey: "data.provider_timeout" }), null);
  assert.equal(marketDateRecovery({ ...diagnostic, details: { ...diagnostic.details, availableFrom: "2021-02-30" } }), null);
  const bad = marketDateRecovery({ ...diagnostic, details: { ...diagnostic.details, suggestedEndDate: "2020-12-31" } });
  assert.equal(bad.range, null);
  assert.equal(applyMarketDateRecovery(shared, bad), shared);
});
