import { describe, expect, it } from "vitest";
import { PLUGIN_NAME } from "../src/index.js";

describe("smoke", () => {
  it("exports the plugin name", () => {
    expect(PLUGIN_NAME).toBe("cloudflare-ai-gateway-chatgpt");
  });
});
