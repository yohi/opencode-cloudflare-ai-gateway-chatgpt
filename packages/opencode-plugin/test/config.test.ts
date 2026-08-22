import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_SLUG,
  PRODUCTION_GATEWAY_BASE_URL,
  resolveConfig,
} from "../src/config.js";
import { PluginConfigurationError } from "../src/errors.js";

const baseEnv = {
  CLOUDFLARE_ACCOUNT_ID: "acct",
  CLOUDFLARE_GATEWAY_ID: "gw",
};

describe("required identifiers", () => {
  it("throws when CLOUDFLARE_ACCOUNT_ID is missing", () => {
    expect(() =>
      resolveConfig({ CLOUDFLARE_GATEWAY_ID: "gw" }),
    ).toThrow(PluginConfigurationError);
  });

  it("throws when CLOUDFLARE_GATEWAY_ID is missing", () => {
    expect(() =>
      resolveConfig({ CLOUDFLARE_ACCOUNT_ID: "acct" }),
    ).toThrow(PluginConfigurationError);
  });

  it("treats empty-string env values as unset", () => {
    expect(() =>
      resolveConfig({ ...baseEnv, CLOUDFLARE_ACCOUNT_ID: "" }),
    ).toThrow(PluginConfigurationError);
  });
});

describe("gateway token resolution", () => {
  it("prefers CLOUDFLARE_API_TOKEN over CF_AIG_TOKEN and apiKey", () => {
    const config = resolveConfig(
      {
        ...baseEnv,
        CLOUDFLARE_API_TOKEN: "from-api-token-env",
        CF_AIG_TOKEN: "from-cf-aig-env",
      },
      { apiKey: "from-option", relayToken: "relay" },
    );
    expect(config.gatewayToken).toBe("from-api-token-env");
  });

  it("falls back to CF_AIG_TOKEN", () => {
    const config = resolveConfig(
      {
        ...baseEnv,
        CF_AIG_TOKEN: "from-cf-aig-env",
      },
      { apiKey: "from-option", relayToken: "relay" },
    );
    expect(config.gatewayToken).toBe("from-cf-aig-env");
  });

  it("falls back to the apiKey plugin setting", () => {
    const config = resolveConfig(baseEnv, {
      apiKey: "from-option",
      relayToken: "relay",
    });
    expect(config.gatewayToken).toBe("from-option");
  });

  it("throws when no gateway token source exists", () => {
    expect(() =>
      resolveConfig(baseEnv, { relayToken: "relay" }),
    ).toThrow(PluginConfigurationError);
  });

  it("rejects a non-string apiKey option", () => {
    expect(() =>
      resolveConfig(baseEnv, { apiKey: 42, relayToken: "relay" }),
    ).toThrow(PluginConfigurationError);
  });
});

describe("relay token resolution", () => {
  it("prefers the environment variable over the plugin setting", () => {
    const config = resolveConfig(baseEnv, {
      relayToken: "from-option",
      apiKey: "gw-token",
    });
    expect(config.relayToken).toBe("from-option");
  });

  it("uses CLOUDFLARE_CHATGPT_RELAY_TOKEN first", () => {
    const config = resolveConfig(
      {
        ...baseEnv,
        CLOUDFLARE_CHATGPT_RELAY_TOKEN: "from-env",
      },
      { relayToken: "from-option", apiKey: "gw-token" },
    );
    expect(config.relayToken).toBe("from-env");
  });

  it("throws when neither source exists", () => {
    expect(() =>
      resolveConfig(baseEnv, { apiKey: "gw-token" }),
    ).toThrow(PluginConfigurationError);
  });
});

describe("provider slug resolution", () => {
  it("defaults to chatgpt-codex-deno", () => {
    const config = resolveConfig(baseEnv, { apiKey: "gw", relayToken: "relay" });
    expect(config.providerSlug).toBe(DEFAULT_PROVIDER_SLUG);
    expect(DEFAULT_PROVIDER_SLUG).toBe("chatgpt-codex-deno");
  });

  it("prefers the environment variable, then the plugin setting", () => {
    const fromOption = resolveConfig(baseEnv, {
      providerSlug: "custom-slug",
      apiKey: "gw",
      relayToken: "relay",
    });
    expect(fromOption.providerSlug).toBe("custom-slug");

    const fromEnv = resolveConfig(
      {
        ...baseEnv,
        CLOUDFLARE_CHATGPT_PROVIDER_SLUG: "env-slug",
      },
      { providerSlug: "custom-slug", apiKey: "gw", relayToken: "relay" },
    );
    expect(fromEnv.providerSlug).toBe("env-slug");
  });
});

describe("collectLogPayload resolution", () => {
  const full = (extra: Record<string, string>) =>
    resolveConfig(
      { ...baseEnv, ...extra },
      {
        apiKey: "gw",
        relayToken: "relay",
      },
    );

  it("accepts exact lowercase true and false from the environment", () => {
    expect(
      full({ CLOUDFLARE_AIG_COLLECT_LOG_PAYLOAD: "true" }).collectLogPayload,
    ).toBe(true);
    expect(
      full({ CLOUDFLARE_AIG_COLLECT_LOG_PAYLOAD: "false" }).collectLogPayload,
    ).toBe(false);
  });

  it("rejects invalid environment values without echoing them", () => {
    try {
      full({ CLOUDFLARE_AIG_COLLECT_LOG_PAYLOAD: "TRUE" });
      throw new Error("expected PluginConfigurationError");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginConfigurationError);
      if (error instanceof Error) {
        expect(error.message).not.toContain("TRUE");
      }
    }
  });

  it("falls through to the boolean option and rejects non-booleans", () => {
    const config = resolveConfig(baseEnv, {
      collectLogPayload: false,
      apiKey: "gw",
      relayToken: "relay",
    });
    expect(config.collectLogPayload).toBe(false);

    expect(() =>
      resolveConfig(baseEnv, {
        collectLogPayload: "false",
        apiKey: "gw",
        relayToken: "relay",
      }),
    ).toThrow(PluginConfigurationError);
  });

  it("defaults to true when unset everywhere", () => {
    expect(full({}).collectLogPayload).toBe(true);
  });
});

describe("gateway base URL resolution", () => {
  const full = (extra: Record<string, string>) =>
    resolveConfig(
      { ...baseEnv, ...extra },
      {
        apiKey: "gw",
        relayToken: "relay",
      },
    );

  it("uses the production origin by default", () => {
    expect(full({}).gatewayBaseUrl).toBe(PRODUCTION_GATEWAY_BASE_URL);
    expect(PRODUCTION_GATEWAY_BASE_URL).toBe(
      "https://gateway.ai.cloudflare.com",
    );
  });

  it("accepts the override only in allowlisted test mode", () => {
    const config = full({
      CLOUDFLARE_AIG_TEST_MODE: "true",
      CLOUDFLARE_AIG_BASE_URL: "https://gateway.test.invalid",
    });
    expect(config.gatewayBaseUrl).toBe("https://gateway.test.invalid");
  });

  it("rejects overrides outside test mode or off the allowlist", () => {
    expect(() =>
      full({ CLOUDFLARE_AIG_BASE_URL: "https://gateway.test.invalid" }),
    ).toThrow(PluginConfigurationError);
    expect(() =>
      full({
        CLOUDFLARE_AIG_TEST_MODE: "true",
        CLOUDFLARE_AIG_BASE_URL: "https://evil.example",
      }),
    ).toThrow(PluginConfigurationError);
    expect(() =>
      full({
        CLOUDFLARE_AIG_TEST_MODE: "true",
        CLOUDFLARE_AIG_BASE_URL: "http://gateway.test.invalid",
      }),
    ).toThrow(PluginConfigurationError);
    expect(() =>
      full({
        CLOUDFLARE_AIG_TEST_MODE: "true",
        CLOUDFLARE_AIG_BASE_URL: "not-a-url",
      }),
    ).toThrow(PluginConfigurationError);
  });
});
