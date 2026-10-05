import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { atScrollBoundary, wheelDeltaPixels } = require("../.test-output/features/results/useTableScrollBoundary.js");

test("table scrolling reaches only the matching boundary, with fractional endpoints tolerated", () => {
  const area = { scrollTop: 120, clientHeight: 358, scrollHeight: 3586 };
  assert.equal(atScrollBoundary(area, 140), false);
  assert.equal(atScrollBoundary(area, -140), false);
  assert.equal(atScrollBoundary({ ...area, scrollTop: 0 }, 140), false);
  assert.equal(atScrollBoundary({ ...area, scrollTop: 0 }, -140), true);
  assert.equal(atScrollBoundary({ ...area, scrollTop: 3227.5 }, 140), true);
  assert.equal(atScrollBoundary({ ...area, scrollTop: 3227.5 }, -140), false);
  assert.equal(atScrollBoundary(area, 0), false);
});

test("wheel direction and pixel, line and page units are preserved", () => {
  assert.equal(wheelDeltaPixels(140, 0, 20, 358), 140);
  assert.equal(wheelDeltaPixels(-3, 1, 20, 358), -60);
  assert.equal(wheelDeltaPixels(2, 2, 20, 358), 716);
});
