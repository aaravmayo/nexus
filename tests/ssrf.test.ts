import { describe, it } from "node:test";
import assert from "node:assert";
import { isBlockedIp, validateUrlForSsrf, SsrfError } from "../src/lib/ssrf.js";

describe("SSRF Protection", () => {
  it("blocks private, loopback, link-local and metadata IPs", () => {
    assert.strictEqual(isBlockedIp("127.0.0.1"), true);
    assert.strictEqual(isBlockedIp("10.0.0.1"), true);
    assert.strictEqual(isBlockedIp("192.168.1.5"), true);
    assert.strictEqual(isBlockedIp("172.16.0.1"), true);
    assert.strictEqual(isBlockedIp("169.254.169.254"), true);
    assert.strictEqual(isBlockedIp("::1"), true);
    assert.strictEqual(isBlockedIp("::ffff:127.0.0.1"), true);
    assert.strictEqual(isBlockedIp("::ffff:192.168.1.1"), true);
    assert.strictEqual(isBlockedIp("fe80::1"), true);
    assert.strictEqual(isBlockedIp("invalid-ip"), true);
  });

  it("permits public IPs", () => {
    assert.strictEqual(isBlockedIp("8.8.8.8"), false);
    assert.strictEqual(isBlockedIp("1.1.1.1"), false);
  });

  it("rejects non-http/https schemes and localhost hostnames", async () => {
    await assert.rejects(
      () => validateUrlForSsrf("ftp://example.com"),
      (err: SsrfError) => {
        assert.match(err.message, /Unsupported protocol/);
        return true;
      }
    );

    await assert.rejects(
      () => validateUrlForSsrf("file:///etc/passwd"),
      (err: SsrfError) => {
        assert.match(err.message, /Unsupported protocol/);
        return true;
      }
    );

    await assert.rejects(
      () => validateUrlForSsrf("http://localhost:3000"),
      (err: SsrfError) => {
        assert.match(err.message, /prohibited/);
        return true;
      }
    );

    await assert.rejects(
      () => validateUrlForSsrf("http://127.0.0.1/admin"),
      (err: SsrfError) => {
        assert.match(err.message, /blocked IP/);
        return true;
      }
    );
  });
});
