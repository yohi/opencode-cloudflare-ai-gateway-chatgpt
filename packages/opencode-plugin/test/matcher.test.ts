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
