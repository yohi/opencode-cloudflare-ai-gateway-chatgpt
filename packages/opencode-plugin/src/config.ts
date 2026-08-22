import { PluginConfigurationError } from "./errors.js";

export type EnvSource = Readonly<Record<string, string | undefined>>;

export type PluginOptions = {
  readonly apiKey?: unknown;
  readonly relayToken?: unknown;
  readonly providerSlug?: unknown;
  readonly collectLogPayload?: unknown;
};

export type ResolvedConfig = {
  readonly accountId: string;
  readonly gatewayId: string;
  readonly gatewayToken: string;
  readonly relayToken: string;
  readonly providerSlug: string;
  readonly collectLogPayload: boolean;
  readonly gatewayBaseUrl: string;
};

export const DEFAULT_PROVIDER_SLUG = "chatgpt-codex-deno";
export const PRODUCTION_GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com";

const TEST_GATEWAY_BASE_ORIGIN = "https://gateway.test.invalid";

function envValue(env: EnvSource, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

function requireEnv(env: EnvSource, name: string): string {
  const value = envValue(env, name);
  if (value === undefined) {
    throw new PluginConfigurationError(
      `cloudflare-ai-gateway-chatgpt: ${name} is required.`,
    );
  }
  return value;
}

function requireSecret(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PluginConfigurationError(
      `cloudflare-ai-gateway-chatgpt: ${label} is missing or invalid.`,
    );
  }
  return value;
}

function resolveCollectLogPayload(
  env: EnvSource,
  options: PluginOptions,
): boolean {
  const raw = envValue(env, "CLOUDFLARE_AIG_COLLECT_LOG_PAYLOAD");
  if (raw !== undefined) {
    if (raw === "true") {
      return true;
    }
    if (raw === "false") {
      return false;
    }
    throw new PluginConfigurationError(
      "cloudflare-ai-gateway-chatgpt: CLOUDFLARE_AIG_COLLECT_LOG_PAYLOAD" +
        ' must be exactly "true" or "false".',
    );
  }
  if (options.collectLogPayload !== undefined) {
    if (typeof options.collectLogPayload === "boolean") {
      return options.collectLogPayload;
    }
    throw new PluginConfigurationError(
      "cloudflare-ai-gateway-chatgpt: plugin setting collectLogPayload" +
        " must be a boolean.",
    );
  }
  return true;
}

function resolveGatewayBaseUrl(env: EnvSource): string {
  const override = envValue(env, "CLOUDFLARE_AIG_BASE_URL");
  if (override === undefined) {
    return PRODUCTION_GATEWAY_BASE_URL;
  }
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new PluginConfigurationError(
      "cloudflare-ai-gateway-chatgpt: CLOUDFLARE_AIG_BASE_URL is not a valid URL.",
    );
  }
  const testMode = envValue(env, "CLOUDFLARE_AIG_TEST_MODE") === "true";
  if (testMode && parsed.origin === TEST_GATEWAY_BASE_ORIGIN) {
    return parsed.origin;
  }
  throw new PluginConfigurationError(
    "cloudflare-ai-gateway-chatgpt: CLOUDFLARE_AIG_BASE_URL override" +
      " requires CLOUDFLARE_AIG_TEST_MODE=true and the allowlisted test" +
      " origin.",
  );
}

function resolveProviderSlug(
  env: EnvSource,
  options: PluginOptions,
): string {
  const fromEnv = envValue(env, "CLOUDFLARE_CHATGPT_PROVIDER_SLUG");
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  if (options.providerSlug === undefined) {
    return DEFAULT_PROVIDER_SLUG;
  }
  if (typeof options.providerSlug !== "string") {
    throw new PluginConfigurationError(
      "cloudflare-ai-gateway-chatgpt: plugin setting providerSlug" +
        " must be a non-empty string.",
    );
  }
  return options.providerSlug.length > 0
    ? options.providerSlug
    : DEFAULT_PROVIDER_SLUG;
}

export function resolveConfig(
  env: EnvSource,
  options: PluginOptions = {},
): ResolvedConfig {
  const gatewayToken =
    envValue(env, "CLOUDFLARE_API_TOKEN") ??
    envValue(env, "CF_AIG_TOKEN") ??
    requireSecret(options.apiKey, "Gateway token (plugin setting apiKey)");
  const relayToken =
    envValue(env, "CLOUDFLARE_CHATGPT_RELAY_TOKEN") ??
    requireSecret(options.relayToken, "Relay token (plugin setting relayToken)");

  return {
    accountId: requireEnv(env, "CLOUDFLARE_ACCOUNT_ID"),
    gatewayId: requireEnv(env, "CLOUDFLARE_GATEWAY_ID"),
    gatewayToken,
    relayToken,
    providerSlug: resolveProviderSlug(env, options),
    collectLogPayload: resolveCollectLogPayload(env, options),
    gatewayBaseUrl: resolveGatewayBaseUrl(env),
  };
}
