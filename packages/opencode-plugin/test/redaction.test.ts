import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { PluginConfigurationError } from "../src/errors.js";

const sentinelGateway = "sentinel-gw-do-not-leak";
const sentinelRelay = "sentinel-relay-do-not-leak";

function expectNoCredentials(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  expect(message).not.toContain(sentinelGateway);
  expect(message).not.toContain(sentinelRelay);
}

describe("diagnostics redaction", () => {
  it("never includes credentials in configuration errors", () => {
    try {
      resolveConfig(
        {
          CLOUDFLARE_ACCOUNT_ID: "acct",
          CLOUDFLARE_GATEWAY_ID: "gw",
          CLOUDFLARE_API_TOKEN: sentinelGateway,
        },
        {},
      );
      throw new Error("expected PluginConfigurationError");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginConfigurationError);
      expectNoCredentials(error);
    }

    try {
      resolveConfig(
        {
          CLOUDFLARE_ACCOUNT_ID: "acct",
          CLOUDFLARE_GATEWAY_ID: "gw",
          CLOUDFLARE_CHATGPT_RELAY_TOKEN: sentinelRelay,
        },
        {},
      );
      throw new Error("expected PluginConfigurationError");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginConfigurationError);
      expectNoCredentials(error);
    }
  });

  it("never includes credentials in invalid collect-log-payload errors", () => {
    try {
      resolveConfig(
        {
          CLOUDFLARE_ACCOUNT_ID: "acct",
          CLOUDFLARE_GATEWAY_ID: "gw",
          CLOUDFLARE_API_TOKEN: sentinelGateway,
          CLOUDFLARE_CHATGPT_RELAY_TOKEN: sentinelRelay,
          CLOUDFLARE_AIG_COLLECT_LOG_PAYLOAD: "yes",
        },
        {},
      );
      throw new Error("expected PluginConfigurationError");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginConfigurationError);
      expectNoCredentials(error);
    }
  });
});
