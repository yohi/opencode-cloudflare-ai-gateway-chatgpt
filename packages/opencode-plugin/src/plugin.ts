import type { Plugin } from "@opencode-ai/plugin";
import { resolveConfig, type PluginOptions } from "./config.js";
import {
  assertSupportedHost,
  resolveHostVersionCapability,
} from "./host-version.js";
import { installFetchInterposer } from "./interposer.js";

export const CloudflareAiGatewayChatgpt: Plugin = async (input, options) => {
  assertSupportedHost(resolveHostVersionCapability(input));
  installFetchInterposer({
    resolveConfig: () =>
      resolveConfig(process.env, (options ?? {}) as PluginOptions),
  });
  return {};
};
