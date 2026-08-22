import { describe, expect, it } from "vitest";
import { isChatgptCodexResponsesRequest } from "../src/matcher.js";

describe("isChatgptCodexResponsesRequest", () => {
  it("matches only the exact endpoint with POST", () => {
    expect(
      isChatgptCodexResponsesRequest(
        "POST",
        "https://chatgpt.com/backend-api/codex/responses",
      ),
    ).toBe(true);
  });

  it("rejects the endpoint on a non-default port", () => {
    expect(
      isChatgptCodexResponsesRequest(
        "POST",
        "https://chatgpt.com:8443/backend-api/codex/responses",
      ),
    ).toBe(false);
  });

  it("rejects other methods, hosts, schemes, paths, and queries", () => {
    expect(
      isChatgptCodexResponsesRequest(
        "GET",
        "https://chatgpt.com/backend-api/codex/responses",
      ),
    ).toBe(false);
    expect(
      isChatgptCodexResponsesRequest(
        "POST",
        "http://chatgpt.com/backend-api/codex/responses",
      ),
    ).toBe(false);
    expect(
      isChatgptCodexResponsesRequest(
        "POST",
        "https://api.openai.com/v1/responses",
      ),
    ).toBe(false);
    expect(
      isChatgptCodexResponsesRequest(
        "POST",
        "https://auth.openai.com/oauth/token",
      ),
    ).toBe(false);
    expect(
      isChatgptCodexResponsesRequest(
        "POST",
        "https://chatgpt.com/backend-api/other",
      ),
    ).toBe(false);
    expect(
      isChatgptCodexResponsesRequest(
        "POST",
        "https://chatgpt.com/backend-api/codex/responses?trace=1",
      ),
    ).toBe(false);
    expect(isChatgptCodexResponsesRequest("POST", "not a url")).toBe(false);
  });
});
