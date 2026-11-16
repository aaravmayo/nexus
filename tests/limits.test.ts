import { describe, it } from "node:test";
import assert from "node:assert";
import { assertConversationTurnLimit, getCurrentYearMonth, LimitExceededError } from "../src/lib/limits.js";
import { CONFIG } from "../src/config.js";

describe("Limits & Quota Logic", () => {
  it("enforces maximum 20 user turns per conversation", () => {
    // 0 to 19 turns are allowed
    assert.doesNotThrow(() => assertConversationTurnLimit(0));
    assert.doesNotThrow(() => assertConversationTurnLimit(10));
    assert.doesNotThrow(() => assertConversationTurnLimit(19));

    // Turn 20 throws LimitExceededError
    assert.throws(
      () => assertConversationTurnLimit(20),
      (err: LimitExceededError) => {
        assert.strictEqual(err.statusCode, 400);
        assert.match(err.message, /maximum 20 turns/);
        return true;
      }
    );
  });

  it("formats current year month as YYYY-MM UTC", () => {
    const ym = getCurrentYearMonth();
    assert.match(ym, /^\d{4}-\d{2}$/);
  });

  it("verifies server beta limits configuration integrity", () => {
    assert.strictEqual(CONFIG.LIMITS.MAX_CONVERSATIONS_PER_MONTH, 100);
    assert.strictEqual(CONFIG.LIMITS.MAX_MESSAGES_PER_MONTH, 1000);
    assert.strictEqual(CONFIG.LIMITS.MAX_USER_TURNS_PER_CONVERSATION, 20);
    assert.strictEqual(CONFIG.LIMITS.MAX_ACTIVE_WEBSITE_PAGES, 25);
    assert.strictEqual(CONFIG.LIMITS.MAX_ACTIVE_FILES, 5);
    assert.strictEqual(CONFIG.LIMITS.MAX_ACTIVE_EXTRACTED_CHARS, 250000);
    assert.strictEqual(CONFIG.LIMITS.MAX_ACTIVE_CHUNKS, 1000);
  });
});
