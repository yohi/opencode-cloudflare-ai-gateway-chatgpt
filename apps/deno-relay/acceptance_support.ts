export type GatewayAcceptanceConfig = {
  readonly gatewayBaseUrl: string;
  readonly model: string;
  readonly gatewayToken: string;
  readonly commandCodeApiKey: string;
};

export type ExpectedJsonResponse = {
  readonly body: string;
  readonly label: string;
  readonly status: number;
};

export const acceptanceTimeoutMs = 30_000;

const gatewayAcceptanceEnvironmentNames = [
  "RELAY_ACCEPTANCE_GATEWAY_BASE_URL",
  "RELAY_ACCEPTANCE_MODEL",
  "RELAY_ACCEPTANCE_GATEWAY_TOKEN",
  "RELAY_ACCEPTANCE_COMMAND_CODE_API_KEY",
] as const;

const safeRootAnyOf = {
  anyOf: [
    { type: "object", properties: { query: { type: "string" } } },
    { type: "object", properties: { limit: { type: "integer" } } },
  ],
} as const;

export const openAiInvalidJsonEnvelope =
  '{"error":{"message":"Invalid JSON request body","type":"invalid_request_error","param":null,"code":null}}';
export const anthropicInvalidJsonEnvelope =
  '{"type":"error","error":{"type":"invalid_request_error","message":"Invalid JSON request body"}}';

function readEnvironmentValue(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

export function isGatewayAcceptanceConfigured(
  readValue: (name: string) => string | undefined = readEnvironmentValue,
): boolean {
  return gatewayAcceptanceEnvironmentNames.every((name) => {
    const value = readValue(name);
    return value !== undefined && value.trim().length > 0;
  });
}

function requiredEnvironmentValue(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function normalizeAcceptanceOrigin(
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const origin = value.trim().replace(/\/+$/, "");
  return origin.length === 0 ? undefined : origin;
}

export function readGatewayAcceptanceConfig(): GatewayAcceptanceConfig {
  return {
    gatewayBaseUrl: requiredEnvironmentValue(
      "RELAY_ACCEPTANCE_GATEWAY_BASE_URL",
    ),
    model: requiredEnvironmentValue("RELAY_ACCEPTANCE_MODEL"),
    gatewayToken: requiredEnvironmentValue("RELAY_ACCEPTANCE_GATEWAY_TOKEN"),
    commandCodeApiKey: requiredEnvironmentValue(
      "RELAY_ACCEPTANCE_COMMAND_CODE_API_KEY",
    ),
  };
}

function gatewayEndpoint(
  config: GatewayAcceptanceConfig,
  path: string,
): string {
  const base = new URL(config.gatewayBaseUrl);
  const validGatewayPath = /^\/v1\/[^/]+\/[^/]+\/?$/;
  if (
    base.protocol !== "https:" ||
    base.hostname !== "gateway.ai.cloudflare.com" ||
    base.port.length > 0 ||
    base.username.length > 0 ||
    base.password.length > 0 ||
    base.search.length > 0 ||
    base.hash.length > 0 ||
    !validGatewayPath.test(base.pathname) ||
    !path.startsWith("/")
  ) {
    throw new Error("invalid protected acceptance Gateway URL");
  }
  const basePath = base.pathname.replace(/\/+$/, "");
  return `${base.origin}${basePath}/custom-command-code${path}`;
}

export function requestThroughGateway(
  config: GatewayAcceptanceConfig,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cf-aig-authorization", `Bearer ${config.gatewayToken}`);
  return fetch(gatewayEndpoint(config, path), {
    ...init,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(acceptanceTimeoutMs),
  });
}

export function openAiAnyOfBody(config: GatewayAcceptanceConfig): string {
  return JSON.stringify({
    model: config.model,
    messages: [{ role: "user", content: "Reply with ACCEPTANCE_OK." }],
    tools: [{
      type: "function",
      function: {
        name: "acceptance_tool",
        parameters: safeRootAnyOf,
      },
    }],
  });
}

export function anthropicAnyOfBody(config: GatewayAcceptanceConfig): string {
  return JSON.stringify({
    model: config.model,
    max_tokens: 16,
    messages: [{ role: "user", content: "Reply with ACCEPTANCE_OK." }],
    tools: [{
      name: "acceptance_tool",
      input_schema: safeRootAnyOf,
    }],
  });
}

export async function assertSuccessfulResponse(
  response: Response,
  label: string,
): Promise<void> {
  try {
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `${label} expected a successful response, received ${response.status}`,
      );
    }
  } finally {
    await response.body?.cancel();
  }
}

export async function assertJsonResponse(
  response: Response,
  expected: ExpectedJsonResponse,
): Promise<void> {
  if (response.status !== expected.status) {
    await response.body?.cancel();
    throw new Error(
      `${expected.label} returned an unexpected status: expected ${expected.status}, received ${response.status}`,
    );
  }
  const body = await response.text();
  if (body !== expected.body) {
    throw new Error(
      `${expected.label} returned an unexpected error envelope`,
    );
  }
}
