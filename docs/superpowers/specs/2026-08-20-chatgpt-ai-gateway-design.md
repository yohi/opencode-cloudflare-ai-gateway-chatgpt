# Cloudflare AI Gateway ChatGPT Plugin Design

**Date:** 2026-08-20

**Status:** Approved for implementation planning

## Scope

This repository will contain two independently deployable deliverables:

- `packages/opencode-plugin`: the npm package
  `@yohi/cloudflare-ai-gateway-chatgpt`.
- `apps/deno-relay`: the Deno Deploy fixed-upstream egress relay.

The existing `@yohi/cloudflare-ai-gateway-byok` package remains in its own
repository. A compatible BYOK release is a mandatory release prerequisite, not
a runtime dependency of either deliverable in this repository. Cloudflare Custom
Provider and Deno Deploy provisioning are operational prerequisites and out of
scope for plugin runtime behavior.

## Decisions

- Use a narrowly scoped `globalThis.fetch` interposer for v1.
- Support only a documented, tested range of OpenCode versions. If the
  interception contract cannot be established, ChatGPT Codex requests fail
  closed; they never bypass the gateway.
- Preserve OpenCode-owned OAuth, token refresh, Codex protocol, model choice,
  request payload, and response handling. Neither deliverable implements or
  stores OAuth credentials.
- Use deterministic unit and contract tests in ordinary CI. Run real Cloudflare,
  Deno Deploy, and ChatGPT OAuth tests only in a protected environment with
  explicitly supplied credentials.

## Architecture

```text
OpenCode built-in ChatGPT OAuth
  -> plugin fetch interposer
  -> Cloudflare AI Gateway Custom Provider
  -> Deno Deploy relay
  -> https://chatgpt.com/backend-api/codex/responses
```

The plugin is the routing and Gateway-header layer. Cloudflare AI Gateway is
the sole observability plane. The relay is a minimal egress transport. No path
may fall back directly to ChatGPT when the Gateway or relay fails.

### Package Boundaries

`packages/opencode-plugin` owns:

- OpenCode plugin registration and the process-wide fetch interposer.
- Matching the ChatGPT Codex request, building the Gateway URL, resolving
  configuration, and adding Gateway and relay control headers.
- Fail-closed configuration errors for matching requests.

`apps/deno-relay` owns:

- The `POST /v1/responses` route and relay bearer-token validation.
- Fixed-upstream forwarding, request header sanitation, and streaming response
  pass-through.

The packages share no runtime library. Their only coupling is the documented
HTTP contract: Gateway Custom Provider requests arrive at `POST /v1/responses`
with `X-ChatGPT-Relay-Authorization`.

## Plugin Request Handling

The interposer installs once per process and delegates to the fetch function
that was active when it was installed. It does not intercept, transform, or
block requests other than the following exact request:

```text
POST https://chatgpt.com/backend-api/codex/responses
```

In particular, `auth.openai.com`, `api.openai.com`, other `chatgpt.com`
traffic, and ChatGPT OAuth login or refresh traffic pass through unchanged.

For a matching request, the plugin:

1. Validates its required Gateway and relay configuration.
2. Replaces only the URL with:

   ```text
   {CLOUDFLARE_AIG_BASE_URL or https://gateway.ai.cloudflare.com}/v1/
   {CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/
   custom-{providerSlug}/responses
   ```

3. Copies the existing headers without removing or replacing `Authorization`,
   `ChatGPT-Account-Id`, the residency header, or other Codex headers.
4. Adds or sets the following control headers:

   ```http
   cf-aig-authorization: Bearer <Gateway token>
   X-ChatGPT-Relay-Authorization: Bearer <relay token>
   cf-aig-collect-log: true
   cf-aig-collect-log-payload: <true|false>
   cf-aig-metadata: {"source":"opencode","auth_type":"chatgpt_subscription","plugin":"cloudflare-ai-gateway-chatgpt"}
   cf-aig-skip-cache: true
   cf-aig-max-attempts: 1
   ```

5. Calls the original fetch with the original method, body stream, and abort
   signal. It neither reads nor serializes the body.
6. Returns the resulting `Response` unchanged. It does not parse, buffer, or
   reconstruct SSE.

The body therefore retains pure model IDs, `store`, `stream`, `input`, tool
definitions, and all other OpenCode-generated content unchanged.

## Relay Request Handling

The relay accepts only `POST /v1/responses`. Other routes or methods return
`404`. It requires the exact bearer value configured from its Deno Deploy
secret; missing or invalid credentials return `401` before an upstream fetch is
attempted.

After authentication, the relay creates an upstream request fixed to:

```text
https://chatgpt.com/backend-api/codex/responses
```

It forwards the original request body stream without parsing or buffering it.
It retains the OAuth `Authorization`, `ChatGPT-Account-Id`, residency, and
other Codex protocol headers. Before forwarding, it removes header names that
match the following rules:

```text
cf-aig-*
cf-*
x-forwarded-*
forwarded
x-real-ip
X-ChatGPT-Relay-Authorization
host
content-length
connection
```

The relay returns an upstream response with its original status, headers, and
body stream. Upstream `401`, `403`, `429`, and `5xx` results are pass-through
responses, as are streaming SSE responses. The relay has no generic forwarding
route, retry loop, cache, payload persistence, or application logging of
credentials or payloads.

## Configuration

The following values are required for matching ChatGPT Codex requests:

| Setting | Resolution | Notes |
| --- | --- | --- |
| Account ID | `CLOUDFLARE_ACCOUNT_ID` | Required. |
| Gateway ID | `CLOUDFLARE_GATEWAY_ID` | Required. |
| Gateway token | `CLOUDFLARE_API_TOKEN`, then `CF_AIG_TOKEN`, then plugin `apiKey` | Required. Never sent past AI Gateway. |
| Relay token | `CLOUDFLARE_CHATGPT_RELAY_TOKEN`, then plugin `relayToken` | Required. Never sent to ChatGPT. |
| Provider slug | `CLOUDFLARE_CHATGPT_PROVIDER_SLUG`, then plugin `providerSlug`, then `chatgpt-codex-deno` | Used only in the Gateway URL. |
| Log payload collection | `CLOUDFLARE_AIG_COLLECT_LOG_PAYLOAD`, then plugin `collectLogPayload`, then `true` | Controls only Gateway payload logging. |
| Gateway base URL | `CLOUDFLARE_AIG_BASE_URL`, then the production Gateway URL | Test-only endpoint override. |

Only the three fixed metadata entries are emitted. Agent, session, account ID,
OAuth credentials, relay credentials, prompts, and response content are never
added to metadata.

Missing configuration produces a clear plugin configuration error only for a
matching Codex request. It does not interfere with OpenCode authentication or
unrelated provider traffic.

## BYOK Compatibility

The compatible BYOK release must restrict its `Authorization` cleanup to
requests it creates for BYOK. It must not remove OAuth `Authorization` from the
ChatGPT Custom Provider Gateway URL.

The plugin does not take a runtime dependency on BYOK and cannot reliably
detect a later fetch wrapper changing a request. Compatibility is therefore a
release gate:

- Document the minimum compatible BYOK version.
- Run contract tests for both plugin load orders.
- Emit only a best-effort warning when an old version can be identified.

This preserves NFR-005 while preventing the load order from becoming a
workaround.

## Security and Failure Semantics

- Refresh tokens never leave OpenCode.
- Access tokens may traverse the Gateway and relay solely as upstream
  authentication, but are never logged, stored, included in metadata, or
  included in error messages.
- Gateway and relay tokens are distinct credentials. The Gateway token stops at
  Cloudflare; the relay token stops at the relay.
- Gateway failures, relay failures, DNS or connection failures, timeouts, and
  all ChatGPT upstream errors are returned to OpenCode. No direct fallback is
  attempted.

## Test Strategy

### Plugin Unit Tests

- Rewrite only the exact ChatGPT Codex responses endpoint.
- Leave OAuth and non-ChatGPT traffic untouched.
- Preserve OAuth, account, residency, and Codex headers.
- Add each required Gateway, relay, logging, metadata, cache, and retry header.
- Confirm the request bytes are unchanged, including pure model ID, `store`,
  `stream`, input, and tools.
- Confirm SSE responses are returned without inspection or reconstruction.
- Confirm diagnostics never contain credentials or payloads.

### Relay Unit Tests

- Accept only the allowed method and path.
- Reject missing or invalid relay credentials without calling upstream.
- Use the fixed ChatGPT upstream regardless of request data.
- Retain required ChatGPT headers and remove the full header denylist.
- Pass request and response streams through without parsing or buffering.
- Preserve upstream error status and body.
- Confirm logs and errors do not disclose tokens, prompts, or responses.

### Contract and Acceptance Tests

- Compose corrected BYOK and this plugin in both load orders and assert the same
  Gateway URL and preserved OAuth `Authorization`.
- Run unit, contract, typecheck, and lint suites in normal CI.
- Run an explicit protected acceptance suite with real Cloudflare, Deno Deploy,
  and ChatGPT OAuth credentials. It covers 200 SSE, tool calls, reasoning,
  token refresh, representative Gateway/relay/upstream errors, both log-payload
  modes, Gateway log creation, and the Gateway-to-relay-to-upstream path
  mapping.

## Out of Scope

- OAuth, token refresh, account extraction, model catalog, model rewriting,
  retry, cache, quota parsing, or SSE reconstruction.
- Direct ChatGPT fallback or generic proxy behavior.
- `octg` integration or changes.
- Custom Provider or Deno Deploy provisioning automation.
- A native custom Codex endpoint integration. That replaces the fetch
  interposer only when OpenCode formally supports it.
