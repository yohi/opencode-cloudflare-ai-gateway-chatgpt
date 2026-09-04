import {
  assertJsonResponse,
  requestThroughGateway,
} from "./acceptance_support.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("asserts a consumed JSON response without recanceling its body", async () => {
  await assertJsonResponse(new Response('{"ok":true}'), {
    body: '{"ok":true}',
    label: "consumed response",
    status: 200,
  });
});

Deno.test(
  "rejects protected acceptance Gateway URLs outside the Cloudflare allowlist",
  async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = () => {
      fetchCalled = true;
      return Promise.resolve(new Response());
    };

    try {
      const invalidGatewayBaseUrls = [
        "https://gateway.ai.cloudflare.com.evil/v1/account/gateway",
        "https://gateway.ai.cloudflare.com:8443/v1/account/gateway",
        "https://user:pass@gateway.ai.cloudflare.com/v1/account/gateway",
        "https://gateway.ai.cloudflare.com/v1/account/gateway/extra",
        "https://gateway.ai.cloudflare.com/v1/account",
      ];

      for (const gatewayBaseUrl of invalidGatewayBaseUrls) {
        let rejected = false;
        try {
          await requestThroughGateway(
            {
              gatewayBaseUrl,
              model: "acceptance-model",
              gatewayToken: "gateway-token",
              commandCodeApiKey: "command-code-key",
            },
            "/v1/models",
            { method: "GET" },
          );
        } catch (error) {
          rejected = error instanceof Error &&
            error.message === "invalid protected acceptance Gateway URL";
        }
        assert(rejected, "accepted an invalid Gateway URL");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert(!fetchCalled, "fetch was called for an invalid Gateway URL");
  },
);
