import {
  acceptanceTimeoutMs,
  anthropicAnyOfBody,
  anthropicInvalidJsonEnvelope,
  assertJsonResponse,
  assertSuccessfulResponse,
  openAiAnyOfBody,
  openAiInvalidJsonEnvelope,
  readGatewayAcceptanceConfig,
  requestThroughGateway,
} from "./acceptance_support.ts";
import type { GatewayAcceptanceConfig } from "./acceptance_support.ts";

function readAcceptanceOrigin(): string | undefined {
  try {
    const value = Deno.env.get("RELAY_ACCEPTANCE_ORIGIN");
    return value === undefined || value.trim().length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}

const origin = readAcceptanceOrigin();

type ProtectedAcceptanceTest = (
  config: GatewayAcceptanceConfig,
) => Promise<void>;

function protectedAcceptanceTest(
  name: string,
  test: ProtectedAcceptanceTest,
): void {
  Deno.test({
    name,
    ignore: origin === undefined,
    fn: async () => {
      if (origin === undefined) {
        return;
      }
      await test(readGatewayAcceptanceConfig());
    },
  });
}

Deno.test({
  name: "acceptance: relay rejects wrong method with 404",
  ignore: origin === undefined,
  fn: async () => {
    if (origin === undefined) {
      return;
    }
    const response = await fetch(`${origin}/v1/responses`, {
      method: "GET",
      signal: AbortSignal.timeout(acceptanceTimeoutMs),
    });
    try {
      if (response.status !== 404) {
        throw new Error(`expected 404, received ${response.status}`);
      }
    } finally {
      await response.body?.cancel();
    }
  },
});

protectedAcceptanceTest(
  "acceptance: OpenAI root anyOf reaches the provider validator",
  async (config) => {
    const response = await requestThroughGateway(
      config,
      "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.commandCodeApiKey}`,
          "content-type": "application/json",
        },
        body: openAiAnyOfBody(config),
      },
    );
    await assertSuccessfulResponse(response, "OpenAI root anyOf acceptance");
  },
);

protectedAcceptanceTest(
  "acceptance: Anthropic root anyOf route reaches the provider",
  async (config) => {
    const response = await requestThroughGateway(config, "/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.commandCodeApiKey}`,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: anthropicAnyOfBody(config),
    });
    await assertSuccessfulResponse(
      response,
      "Anthropic root anyOf acceptance",
    );
  },
);

protectedAcceptanceTest(
  "acceptance: Command Code models endpoint is reachable",
  async (config) => {
    const response = await requestThroughGateway(config, "/v1/models", {
      method: "GET",
      headers: { authorization: `Bearer ${config.commandCodeApiKey}` },
    });
    await assertSuccessfulResponse(response, "Command Code models acceptance");
  },
);

protectedAcceptanceTest(
  "acceptance: OpenAI malformed JSON returns the provider envelope",
  async (config) => {
    const response = await requestThroughGateway(
      config,
      "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.commandCodeApiKey}`,
          "content-type": "application/json",
        },
        body: "{",
      },
    );
    await assertJsonResponse(response, {
      body: openAiInvalidJsonEnvelope,
      label: "OpenAI malformed JSON acceptance",
      status: 400,
    });
  },
);

protectedAcceptanceTest(
  "acceptance: Anthropic malformed JSON returns the provider envelope",
  async (config) => {
    const response = await requestThroughGateway(config, "/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.commandCodeApiKey}`,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: "{",
    });
    await assertJsonResponse(response, {
      body: anthropicInvalidJsonEnvelope,
      label: "Anthropic malformed JSON acceptance",
      status: 400,
    });
  },
);

protectedAcceptanceTest(
  "acceptance: OpenAI empty JSON returns the provider envelope",
  async (config) => {
    const response = await requestThroughGateway(
      config,
      "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.commandCodeApiKey}`,
          "content-type": "application/json",
        },
      },
    );
    await assertJsonResponse(response, {
      body: openAiInvalidJsonEnvelope,
      label: "OpenAI empty JSON acceptance",
      status: 400,
    });
  },
);

protectedAcceptanceTest(
  "acceptance: Anthropic empty JSON returns the provider envelope",
  async (config) => {
    const response = await requestThroughGateway(config, "/v1/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.commandCodeApiKey}`,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    });
    await assertJsonResponse(response, {
      body: anthropicInvalidJsonEnvelope,
      label: "Anthropic empty JSON acceptance",
      status: 400,
    });
  },
);

Deno.test({
  name: "acceptance: relay rejects missing credentials with 401",
  ignore: origin === undefined,
  fn: async () => {
    if (origin === undefined) {
      return;
    }
    const response = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      signal: AbortSignal.timeout(acceptanceTimeoutMs),
    });
    try {
      if (response.status !== 401) {
        throw new Error(`expected 401, received ${response.status}`);
      }
    } finally {
      await response.body?.cancel();
    }
  },
});
