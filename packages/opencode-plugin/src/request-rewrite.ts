import type { ResolvedConfig } from "./config.js";
import { buildGatewayUrl } from "./gateway-url.js";

export const METADATA_HEADER_VALUE = JSON.stringify({
  source: "opencode",
  auth_type: "chatgpt_subscription",
  plugin: "cloudflare-ai-gateway-chatgpt",
});

export function applyControlHeaders(
  headers: Headers,
  config: ResolvedConfig,
): Headers {
  headers.set("cf-aig-authorization", `Bearer ${config.gatewayToken}`);
  headers.set(
    "x-chatgpt-relay-authorization",
    `Bearer ${config.relayToken}`,
  );
  headers.set("cf-aig-collect-log", "true");
  headers.set(
    "cf-aig-collect-log-payload",
    config.collectLogPayload ? "true" : "false",
  );
  headers.set("cf-aig-metadata", METADATA_HEADER_VALUE);
  headers.set("cf-aig-skip-cache", "true");
  headers.set("cf-aig-max-attempts", "1");
  return headers;
}

export function rewriteCodexRequest(
  request: Request,
  config: ResolvedConfig,
): Request {
  const headers = applyControlHeaders(new Headers(request.headers), config);
  return new Request(buildGatewayUrl(config), {
    method: request.method,
    headers,
    body: request.body,
    signal: request.signal,
    ...(request.body ? ({ duplex: "half" } as RequestInit) : {}),
  });
}
