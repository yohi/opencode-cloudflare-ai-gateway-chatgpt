import { describe, expect, it } from "vitest";
import { buildGatewayUrl } from "../src/gateway-url.js";
import type { ResolvedConfig } from "../src/config.js";

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    accountId: "acct",
    gatewayId: "gw",
    gatewayToken: "token",
    relayToken: "relay",
    providerSlug: "chatgpt-codex-deno",
    collectLogPayload: true,
    gatewayBaseUrl: "https://gateway.ai.cloudflare.com",
    ...overrides,
  };
}

describe("buildGatewayUrl", () => {
  it("maps to the Custom Provider path including /v1/responses", () => {
    expect(buildGatewayUrl(config())).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/custom-chatgpt-codex-deno/v1/responses",
    );
  });

  it("honors a test-mode base URL override", () => {
    expect(
      buildGatewayUrl(
        config({ gatewayBaseUrl: "https://gateway.test.invalid" }),
      ),
    ).toBe(
      "https://gateway.test.invalid/v1/acct/gw/custom-chatgpt-codex-deno/v1/responses",
    );
  });

  it("URI-encodes path segments", () => {
    expect(
      buildGatewayUrl(config({ accountId: "a b", providerSlug: "sl/ug" })),
    ).toBe(
      "https://gateway.ai.cloudflare.com/v1/a%20b/gw/custom-sl%2Fug/v1/responses",
    );
  });
});
