import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/features/results/ReportDownloadButton.tsx", import.meta.url), "utf8");

test("PNG rendering loads on demand after freezing the report", () => {
  assert.doesNotMatch(source, /import\s+\{[^}]*renderResultReport[^}]*\}\s+from/);
  assert.match(source, /await import\("\.\/reportImage"\)/);
  assert.ok(source.indexOf("buildResultReport(run") < source.indexOf('await import("./reportImage")'));
});
