import type { ResolvedConfig } from "./config.js";

export function buildGatewayUrl(config: ResolvedConfig): string {
  const base = new URL(config.gatewayBaseUrl);
  const path =
    `/v1/${encodeURIComponent(config.accountId)}` +
    `/${encodeURIComponent(config.gatewayId)}` +
    `/custom-${encodeURIComponent(config.providerSlug)}` +
    "/v1/responses";
  return `${base.origin}${path}`;
}
