import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../src/config.js";
import {
  installFetchInterposer,
  type FetchLike,
} from "../src/interposer.js";

const config: ResolvedConfig = {
  accountId: "acct",
  gatewayId: "gw",
  gatewayToken: "sentinel-gw-token",
  relayToken: "sentinel-relay-token",
  providerSlug: "chatgpt-codex-deno",
  collectLogPayload: true,
  gatewayBaseUrl: "https://gateway.ai.cloudflare.com",
};

const gatewayUrl =
  "https://gateway.ai.cloudflare.com/v1/acct/gw/custom-chatgpt-codex-deno/v1/responses";
const codexUrl = "https://chatgpt.com/backend-api/codex/responses";

type RecordedRequest = { url: string; headers: Headers };

function createSpy(): { fetch: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, headers: request.headers });
    return new Response("ok");
  };
  return { fetch, requests };
}

function createCorrectedByokInterposer(inner: FetchLike): FetchLike {
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://api.openai.com/")) {
      return inner(input, init);
    }
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    return inner(
      "https://gateway.ai.cloudflare.com/v1/byok-acct/byok-gw/openai",
      { ...init, headers },
    );
  };
}

describe("BYOK compatibility contract", () => {
  it("preserves OAuth Authorization when BYOK loads first", async () => {
    const spy = createSpy();
    const target: { fetch: FetchLike } = { fetch: spy.fetch };
    target.fetch = createCorrectedByokInterposer(target.fetch);
    installFetchInterposer({ resolveConfig: () => config, target });

    await target.fetch(codexUrl, {
      method: "POST",
      headers: {
        Authorization: "Bearer oauth-access-token",
        "ChatGPT-Account-Id": "account-42",
      },
      body: '{"model":"gpt-5.6-luna"}',
    });

    expect(spy.requests).toHaveLength(1);
    const sent = spy.requests[0];
    expect(sent.url).toBe(gatewayUrl);
    expect(sent.headers.get("Authorization")).toBe("Bearer oauth-access-token");
    expect(sent.headers.get("ChatGPT-Account-Id")).toBe("account-42");
    expect(sent.headers.get("cf-aig-authorization")).toBe(
      "Bearer sentinel-gw-token",
    );
    expect(sent.headers.get("x-chatgpt-relay-authorization")).toBe(
      "Bearer sentinel-relay-token",
    );
  });

  it("preserves OAuth Authorization when the plugin loads first", async () => {
    const spy = createSpy();
    const target: { fetch: FetchLike } = { fetch: spy.fetch };
    installFetchInterposer({ resolveConfig: () => config, target });
    target.fetch = createCorrectedByokInterposer(target.fetch);

    await target.fetch(codexUrl, {
      method: "POST",
      headers: {
        Authorization: "Bearer oauth-access-token",
        "ChatGPT-Account-Id": "account-42",
      },
      body: '{"model":"gpt-5.6-luna"}',
    });

    expect(spy.requests).toHaveLength(1);
    const sent = spy.requests[0];
    expect(sent.url).toBe(gatewayUrl);
    expect(sent.headers.get("Authorization")).toBe("Bearer oauth-access-token");
    expect(sent.headers.get("ChatGPT-Account-Id")).toBe("account-42");
    expect(sent.headers.get("cf-aig-authorization")).toBe(
      "Bearer sentinel-gw-token",
    );
    expect(sent.headers.get("x-chatgpt-relay-authorization")).toBe(
      "Bearer sentinel-relay-token",
    );
  });

  it("leaves api.openai.com handling to BYOK in both orders", async () => {
    const spy = createSpy();
    const targetA: { fetch: FetchLike } = { fetch: spy.fetch };
    targetA.fetch = createCorrectedByokInterposer(targetA.fetch);
    installFetchInterposer({ resolveConfig: () => config, target: targetA });
    await targetA.fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sk-byok" },
      body: "{}",
    });
    expect(spy.requests[0].url).toBe(
      "https://gateway.ai.cloudflare.com/v1/byok-acct/byok-gw/openai",
    );
    expect(spy.requests[0].headers.get("Authorization")).toBeNull();

    const spyB = createSpy();
    const targetB: { fetch: FetchLike } = { fetch: spyB.fetch };
    installFetchInterposer({ resolveConfig: () => config, target: targetB });
    targetB.fetch = createCorrectedByokInterposer(targetB.fetch);
    await targetB.fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sk-byok" },
      body: "{}",
    });
    expect(spyB.requests[0].url).toBe(
      "https://gateway.ai.cloudflare.com/v1/byok-acct/byok-gw/openai",
    );
    expect(spyB.requests[0].headers.get("Authorization")).toBeNull();
  });
});
