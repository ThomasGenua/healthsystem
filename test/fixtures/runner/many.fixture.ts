/** Two hundred fast tests: the shape whose results `--test-force-exit` cut short most often. */
import { test } from "node:test";
import assert from "node:assert/strict";

for (let i = 0; i < 200; i++) {
  test(`result ${i} is reported`, () => {
    assert.equal(i * 2, i + i);
  });
}
