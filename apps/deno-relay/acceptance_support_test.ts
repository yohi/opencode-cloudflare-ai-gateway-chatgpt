import {
  assertJsonResponse,
  assertSuccessfulResponse,
  isGatewayAcceptanceConfigured,
  normalizeAcceptanceOrigin,
  requestThroughGateway,
} from "./acceptance_support.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function captureError(action: () => Promise<void>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error("expected an Error instance");
  }
  throw new Error("expected the action to throw");
}

Deno.test("detects complete Gateway acceptance configuration without relay secret", () => {
  const values = new Map([
    ["RELAY_ACCEPTANCE_GATEWAY_BASE_URL", "https://gateway.ai.cloudflare.com"],
    ["RELAY_ACCEPTANCE_MODEL", "acceptance-model"],
    ["RELAY_ACCEPTANCE_GATEWAY_TOKEN", "gateway-token"],
    ["RELAY_ACCEPTANCE_COMMAND_CODE_API_KEY", "command-code-key"],
  ]);

  assert(
    isGatewayAcceptanceConfigured((name) => values.get(name)),
    "did not detect complete Gateway acceptance configuration without relay secret",
  );

  values.set("RELAY_ACCEPTANCE_GATEWAY_TOKEN", " ");
  assert(
    !isGatewayAcceptanceConfigured((name) => values.get(name)),
    "accepted an empty protected acceptance configuration value",
  );
});

Deno.test("normalizes relay acceptance origin before appending the relay path", () => {
  assert(
    normalizeAcceptanceOrigin("  https://relay.example///  ") ===
      "https://relay.example",
    "did not trim and remove trailing slashes from the relay origin",
  );
});

Deno.test(
  "reports the actual status for an unsuccessful response",
  async () => {
    const error = await captureError(() =>
      assertSuccessfulResponse(
        new Response(null, { status: 503 }),
        "Gateway acceptance",
      )
    );

    assert(
      error.message ===
        "Gateway acceptance expected a successful response, received 503",
      "did not report the actual unsuccessful response status",
    );
  },
);

Deno.test(
  "reports expected and actual statuses for a JSON response mismatch",
  async () => {
    const error = await captureError(() =>
      assertJsonResponse(new Response("unexpected-body", { status: 502 }), {
        body: "expected-body",
        label: "Gateway envelope",
        status: 400,
      })
    );

    assert(
      error.message ===
        "Gateway envelope returned an unexpected status: expected 400, received 502",
      "did not report expected and actual JSON response statuses",
    );
  },
);

Deno.test(
  "does not include the response body in a JSON envelope mismatch",
  async () => {
    const unexpectedBody = "provider-response-that-must-not-be-logged";
    const error = await captureError(() =>
      assertJsonResponse(new Response(unexpectedBody, { status: 400 }), {
        body: "expected-body",
        label: "Gateway envelope",
        status: 400,
      })
    );

    assert(
      error.message ===
        "Gateway envelope returned an unexpected error envelope",
      "changed the JSON envelope mismatch message unexpectedly",
    );
    assert(
      !error.message.includes(unexpectedBody),
      "included the provider response body in the failure message",
    );
  },
);

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
