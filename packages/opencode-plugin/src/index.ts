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
