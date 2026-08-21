import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../src/config.js";
import {
  applyControlHeaders,
  METADATA_HEADER_VALUE,
  rewriteCodexRequest,
} from "../src/request-rewrite.js";

const config: ResolvedConfig = {
  accountId: "acct",
  gatewayId: "gw",
  gatewayToken: "sentinel-gw-token",
  relayToken: "sentinel-relay-token",
  providerSlug: "chatgpt-codex-deno",
  collectLogPayload: false,
  gatewayBaseUrl: "https://gateway.ai.cloudflare.com",
};

function codexRequest(): Request {
  return new Request("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers: {
      Authorization: "Bearer oauth-access-token",
      "ChatGPT-Account-Id": "account-42",
      "X-Codex-Residency": "us",
    },
    body: '{"model":"gpt-5.6-luna","store":false,"stream":true}',
  });
}

describe("applyControlHeaders", () => {
  it("sets every required control header with exact values", () => {
    const headers = applyControlHeaders(new Headers(), config);
    expect(headers.get("cf-aig-authorization")).toBe(
      "Bearer sentinel-gw-token",
    );
    expect(headers.get("x-chatgpt-relay-authorization")).toBe(
      "Bearer sentinel-relay-token",
    );
    expect(headers.get("cf-aig-collect-log")).toBe("true");
    expect(headers.get("cf-aig-collect-log-payload")).toBe("false");
    expect(headers.get("cf-aig-metadata")).toBe(METADATA_HEADER_VALUE);
    expect(headers.get("cf-aig-skip-cache")).toBe("true");
    expect(headers.get("cf-aig-max-attempts")).toBe("1");
    expect(METADATA_HEADER_VALUE).toBe(
      '{"source":"opencode","auth_type":"chatgpt_subscription","plugin":"cloudflare-ai-gateway-chatgpt"}',
    );
  });
});

describe("rewriteCodexRequest", () => {
  it("preserves OAuth, account, residency headers and body", async () => {
    const original = codexRequest();
    const rewritten = rewriteCodexRequest(original, config);

    expect(rewritten.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/custom-chatgpt-codex-deno/v1/responses",
    );
    expect(rewritten.method).toBe("POST");
    expect(rewritten.headers.get("Authorization")).toBe(
      "Bearer oauth-access-token",
    );
    expect(rewritten.headers.get("ChatGPT-Account-Id")).toBe("account-42");
    expect(rewritten.headers.get("X-Codex-Residency")).toBe("us");
    expect(await rewritten.text()).toBe(
      '{"model":"gpt-5.6-luna","store":false,"stream":true}',
    );
  });

  it("propagates aborts through the rewritten request", () => {
    const controller = new AbortController();
    const original = new Request(
      "https://chatgpt.com/backend-api/codex/responses",
      {
        method: "POST",
        body: "x",
        signal: controller.signal,
      },
    );
    const rewritten = rewriteCodexRequest(original, config);
    expect(rewritten.signal.aborted).toBe(false);
    controller.abort();
    expect(original.signal.aborted).toBe(true);
    expect(rewritten.signal.aborted).toBe(true);
  });
});
