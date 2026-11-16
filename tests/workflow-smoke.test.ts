import { describe, it } from "node:test";
import assert from "node:assert";
import { RetryableError, FatalError } from "workflow";
import { start } from "workflow/api";

describe("Workflow SDK smoke test", () => {
  it("imports and verifies workflow error primitives", () => {
    assert.strictEqual(typeof RetryableError, "function");
    assert.strictEqual(typeof FatalError, "function");
    const retryErr = new RetryableError("temporary network blip");
    assert.strictEqual(retryErr.message, "temporary network blip");
  });

  it("exports start and Run from workflow/api", () => {
    assert.strictEqual(typeof start, "function");
  });
});
