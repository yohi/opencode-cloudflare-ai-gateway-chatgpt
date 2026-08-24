import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareAiGatewayChatgpt } from "../src/plugin.js";
import { UnsupportedOpenCodeVersionError } from "../src/errors.js";

const originalFetch = globalThis.fetch;

function resetInterposerState(): void {
  globalThis.fetch = originalFetch;
  const scope = globalThis as typeof globalThis & {
    __cfAigChatgptInterposerInstalled?: boolean;
  };
  delete scope.__cfAigChatgptInterposerInstalled;
}

afterEach(() => {
  resetInterposerState();
  vi.unstubAllEnvs();
});

describe("CloudflareAiGatewayChatgpt", () => {
  it("rejects activation when the capability is absent", async () => {
    await expect(
      CloudflareAiGatewayChatgpt({} as never),
    ).rejects.toThrow(UnsupportedOpenCodeVersionError);
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("rejects activation for unsupported versions", async () => {
    await expect(
      CloudflareAiGatewayChatgpt({ opencode: { version: "1.18.19" } } as never),
    ).rejects.toThrow(UnsupportedOpenCodeVersionError);
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("installs the interposer when the host version is supported", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
    vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "gw");
    vi.stubEnv("CLOUDFLARE_CHATGPT_RELAY_TOKEN", "sentinel-relay-token");

    const hooks = await CloudflareAiGatewayChatgpt(
      { opencode: { version: "1.19.0" } } as never,
      { apiKey: "sentinel-gw-token" },
    );

    expect(hooks).toEqual({});
    expect(globalThis.fetch).not.toBe(originalFetch);
  });

  it("fails closed with a configuration error", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
    vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "gw");
    vi.stubEnv("CLOUDFLARE_CHATGPT_RELAY_TOKEN", "sentinel-relay-token");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    vi.stubEnv("CF_AIG_TOKEN", "");
    vi.stubGlobal("fetch", async () => {
      throw new Error("unexpected upstream fetch");
    });

    await CloudflareAiGatewayChatgpt(
      { opencode: { version: "1.19.0" } } as never,
      {},
    );

    await expect(
      globalThis.fetch("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST",
        body: "x",
      }),
    ).rejects.toThrow(/apiKey/i);
  });
});
