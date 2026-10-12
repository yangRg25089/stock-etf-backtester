import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { ResultTableFrame } = require("../.test-output/features/results/ResultTableFrame.js");

test("shared table frame owns one accessible scroller and expansion target for every variant", () => {
  for (const locale of ["ja", "zh", "en"]) for (const variant of ["standard", "performance"]) {
    for (const empty of [false, true]) {
      const table = React.createElement("table", null, React.createElement("tbody", null, React.createElement("tr", null, React.createElement("td", null, "saved-value"))));
      const html = renderToStaticMarkup(React.createElement(ResultTableFrame, { locale, variant, title: "Title", label: "Saved table", scrollClassName: "test-table-scroll", disabled: empty,
        emptyContent: empty ? React.createElement("p", null, "No rows") : undefined }, table));
      assert.equal((html.match(/table-expand-button/g) ?? []).length, 1);
      const target = html.match(/aria-controls="([^"]+)"/)[1];
      assert.ok(html.includes(`id="${target}"`));
      assert.match(html, /aria-expanded="false"/);
      if (empty) { assert.match(html, /No rows/); assert.doesNotMatch(html, /<table|saved-value/); }
      else { assert.match(html, /role="region" aria-label="Saved table"/); assert.match(html, /tabindex="0"/); assert.match(html, /saved-value/); }
    }
  }
});

test("all seven result table types use the shared scroll primitive and one expansion owner", () => {
  for (const name of ["MonthlyHeatmap", "PeriodPerformance", "TradeTable", "ResultSummary", "SearchResults"]) {
    const source = readFileSync(new URL(`../src/features/results/${name}.tsx`, import.meta.url), "utf8");
    assert.match(source, /import \{ ResultTableFrame \}/);
    assert.doesNotMatch(source, /ExpandedTableOverflow|TableExpandButton|heightExpanded|setHeightExpanded/);
  }
  const lab = readFileSync(new URL("../src/features/results/SearchLab.tsx", import.meta.url), "utf8");
  assert.match(lab, /<ResultTableScroll/);
  assert.match(lab, /search-heatmap-table/); assert.match(lab, /search-neighbor-table/);
  const css = readFileSync(new URL("../src/styles/result-tables.css", import.meta.url), "utf8");
  assert.match(css, /\.result-table-scroll thead \{[^}]*z-index: 2/);
  assert.match(css, /\.result-table-scroll tbody tr > :first-child \{[^}]*z-index: 1/);
  assert.match(css, /\.table-expanded-overflow thead tr > :first-child \{[^}]*z-index: 4/);
});
