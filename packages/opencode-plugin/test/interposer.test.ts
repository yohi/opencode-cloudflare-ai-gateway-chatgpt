import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../src/config.js";
import {
  installFetchInterposer,
  type FetchLike,
} from "../src/interposer.js";
import { PluginConfigurationError } from "../src/errors.js";

type RecordedRequest = {
  url: string;
  method: string;
  headers: Headers;
  bodyText: string | null;
  signal: AbortSignal | null;
};

function createSpyFetch(responseStatus = 200): {
  fetch: FetchLike;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    const bodyText = request.body === null ? null : await request.text();
    requests.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      bodyText,
      signal: request.signal,
    });
    return new Response("ok", { status: responseStatus });
  };
  return { fetch, requests };
}

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

afterEach(() => {
  const scope = globalThis as typeof globalThis & {
    __cfAigChatgptInterposerInstalled?: boolean;
  };
  delete scope.__cfAigChatgptInterposerInstalled;
});

describe("installFetchInterposer", () => {
  it("passes non-matching traffic through untouched", async () => {
    const spy = createSpyFetch();
    const target: { fetch: FetchLike } = { fetch: spy.fetch };
    installFetchInterposer({ resolveConfig: () => config, target });

    await target.fetch("https://auth.openai.com/oauth/token", {
      method: "POST",
    });
    await target.fetch("https://api.openai.com/v1/models");
    await target.fetch("https://chatgpt.com/backend-api/other", {
      method: "POST",
    });
    await target.fetch(`${codexUrl}?trace=1`, { method: "POST" });
    await target.fetch(codexUrl, { method: "GET" });

    expect(spy.requests).toHaveLength(5);
    for (const request of spy.requests) {
      expect(request.headers.get("cf-aig-authorization")).toBeNull();
      expect(request.headers.get("x-chatgpt-relay-authorization")).toBeNull();
    }
  });

  it("rewrites a matching request given string input and init", async () => {
    const spy = createSpyFetch();
    const target: { fetch: FetchLike } = { fetch: spy.fetch };
    installFetchInterposer({ resolveConfig: () => config, target });

    const controller = new AbortController();
    const response = await target.fetch(codexUrl, {
      method: "POST",
      headers: {
        Authorization: "Bearer oauth-access-token",
        "ChatGPT-Account-Id": "account-42",
      },
      body: '{"model":"gpt-5.6-luna","store":false,"stream":true}',
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(spy.requests).toHaveLength(1);
    const sent = spy.requests[0];
    expect(sent.url).toBe(gatewayUrl);
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("Authorization")).toBe(
      "Bearer oauth-access-token",
    );
    expect(sent.headers.get("ChatGPT-Account-Id")).toBe("account-42");
    expect(sent.headers.get("cf-aig-authorization")).toBe(
      "Bearer sentinel-gw-token",
    );
    expect(sent.headers.get("x-chatgpt-relay-authorization")).toBe(
      "Bearer sentinel-relay-token",
    );
    expect(sent.headers.get("cf-aig-collect-log")).toBe("true");
    expect(sent.headers.get("cf-aig-collect-log-payload")).toBe("true");
    expect(sent.headers.get("cf-aig-metadata")).toBe(
      '{"source":"opencode","auth_type":"chatgpt_subscription","plugin":"cloudflare-ai-gateway-chatgpt"}',
    );
    expect(sent.headers.get("cf-aig-skip-cache")).toBe("true");
    expect(sent.headers.get("cf-aig-max-attempts")).toBe("1");
    expect(sent.bodyText).toBe(
      '{"model":"gpt-5.6-luna","store":false,"stream":true}',
    );
    controller.abort();
    expect(sent.signal?.aborted).toBe(true);
  });

  it("rewrites Request input; returns response object as-is", async () => {
    const spy = createSpyFetch(201);
    const target: { fetch: FetchLike } = { fetch: spy.fetch };
    installFetchInterposer({ resolveConfig: () => config, target });

    const outbound = new Request(codexUrl, {
      method: "POST",
      headers: { Authorization: "Bearer oauth-access-token" },
      body: "payload",
    });
    const response = await target.fetch(outbound);

    expect(spy.requests[0].url).toBe(gatewayUrl);
    expect(spy.requests[0].bodyText).toBe("payload");
    expect(response.status).toBe(201);
  });

  it("fails closed when configuration resolution throws", async () => {
    const spy = createSpyFetch();
    const target: { fetch: FetchLike } = { fetch: spy.fetch };
    installFetchInterposer({
      resolveConfig: () => {
        throw new PluginConfigurationError("missing config");
      },
      target,
    });

    await expect(
      target.fetch(codexUrl, { method: "POST", body: "x" }),
    ).rejects.toThrow(PluginConfigurationError);
    expect(spy.requests).toHaveLength(0);
  });

  it("delegates to the fetch function active at install time", async () => {
    const spy = createSpyFetch();
    const calls: string[] = [];
    const firstWrapper: FetchLike = (input, init) => {
      calls.push("first");
      return spy.fetch(input, init);
    };
    const target: { fetch: FetchLike } = { fetch: firstWrapper };
    installFetchInterposer({ resolveConfig: () => config, target });

    const previous = target.fetch;
    target.fetch = (input, init) => {
      calls.push("second");
      return previous(input, init);
    };

    await target.fetch(codexUrl, { method: "POST", body: "x" });

    expect(calls).toEqual(["second", "first"]);
  });

  it("installs at most once per target", async () => {
    const spy = createSpyFetch();
    const target: { fetch: FetchLike } = { fetch: spy.fetch };
    installFetchInterposer({ resolveConfig: () => config, target });
    const installed = target.fetch;
    installFetchInterposer({
      resolveConfig: () => {
        throw new Error("second install must be ignored");
      },
      target,
    });

    expect(target.fetch).toBe(installed);
  });
});
