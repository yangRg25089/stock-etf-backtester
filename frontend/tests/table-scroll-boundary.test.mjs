import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { atScrollBoundary, hasScrollRoom, wheelDeltaPixels } = require("../.test-output/shared/ui/useScrollBoundary.js");

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

test("a scroll parent retains its final pixel of room at either edge", () => {
  const area = { scrollTop: 1, clientHeight: 480, scrollHeight: 608 };
  assert.equal(hasScrollRoom(area, -10), true);
  assert.equal(hasScrollRoom({ ...area, scrollTop: 0 }, -10), false);
  assert.equal(hasScrollRoom({ ...area, scrollTop: 127.5 }, 10), true);
  assert.equal(hasScrollRoom({ ...area, scrollTop: 128 }, 10), false);
  assert.equal(hasScrollRoom(area, 0), false);
});
