export { PLUGIN_NAME } from "./core.js";
export {
  PluginConfigurationError,
  UnsupportedOpenCodeVersionError,
} from "./errors.js";
export {
  assertSupportedHost,
  resolveHostVersionCapability,
  SUPPORTED_OPENCODE_RANGE,
} from "./host-version.js";
export {
  DEFAULT_PROVIDER_SLUG,
  PRODUCTION_GATEWAY_BASE_URL,
  resolveConfig,
} from "./config.js";
export type { EnvSource, PluginOptions, ResolvedConfig } from "./config.js";
export { buildGatewayUrl } from "./gateway-url.js";
export {
  CHATGPT_CODEX_ORIGIN,
  CHATGPT_CODEX_PATHNAME,
  isChatgptCodexResponsesRequest,
} from "./matcher.js";
export {
  applyControlHeaders,
  METADATA_HEADER_VALUE,
  rewriteCodexRequest,
} from "./request-rewrite.js";
export { installFetchInterposer } from "./interposer.js";
export type { ConfigResolver, FetchLike } from "./interposer.js";
