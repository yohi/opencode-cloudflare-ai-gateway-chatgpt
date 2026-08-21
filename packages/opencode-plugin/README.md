# @yohi/cloudflare-ai-gateway-chatgpt

OpenCode plugin that routes ChatGPT Codex requests through Cloudflare AI Gateway
and a fixed-upstream Deno Deploy relay. Requests fail closed; they never bypass
the gateway.

See the repository root README for configuration, path mapping, supported
versions, and the release checklist.
