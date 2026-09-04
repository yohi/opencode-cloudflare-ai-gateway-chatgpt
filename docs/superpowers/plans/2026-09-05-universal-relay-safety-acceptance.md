# Universal Relay Safety and Acceptance Implementation Plan

> **For agentic workers:** Execute this plan inline in the current session. Do not dispatch subagents.

**Goal:** Resolve the validated body-size and provider-validation acceptance findings without changing the existing legacy relay runtime.

**Architecture:** Keep the current design-only scope for the future generic relay, but make its normalization memory contract executable by a future implementation: a fixed 4 MiB maximum normalized request body, early `Content-Length` rejection, and counted streaming reads for unknown lengths. Extend the existing protected acceptance test to send concrete OpenAI and Anthropic root-`anyOf` fixtures through the Cloudflare AI Gateway Custom Provider and require the workflow to fail when protected configuration is missing.

**Tech Stack:** Deno standard APIs, Deno tests, GitHub Actions, Japanese Markdown requirements and design documents.

## Global Constraints

- Preserve the existing legacy `POST /v1/responses` contract, including request-body streaming and redirect pass-through.
- Apply normalization only to provider-compatible `POST` routes with the matching `application/json` media type.
- Reject an oversized recognized normalization request before upstream fetch; never raw-forward a partial or unbounded normalized body.
- Keep generic relay behavior fail-closed and avoid direct ChatGPT fallbacks, retry loops, caching, and payload persistence.
- Keep `apps/deno-relay` free of runtime dependencies.
- Keep credentials and provider response bodies out of workflow logs and test failure messages.
- Do not claim protected acceptance passed unless the real Cloudflare AI Gateway, Deno Deploy relay, and Command Code API are used.

---

### Task 1: Define the bounded normalization contract

**Files:**
- Modify: `REQUIREMENTS_AI_GATEWAY_RELAY.md`
- Modify: `docs/superpowers/specs/2026-09-04-universal-ai-gateway-relay-design.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-09-04-universal-ai-gateway-relay-anyof-fix.md`

**Interfaces:**
- Consumes: Existing route-specific JSON normalization and 512 MB application memory budget.
- Produces: A fixed `MAX_NORMALIZATION_BODY_BYTES = 4 * 1024 * 1024` contract for future `upstream.ts`/`schema.ts` implementations.

- [x] **Step 1: Add the explicit limit and rejection behavior**

  Document that only recognized provider-compatible JSON routes are bounded. A known `Content-Length` greater than `4 * 1024 * 1024` must return status `413`, `Content-Type: application/json`, and the route-specific envelope before upstream fetch:

  ```json
  {"error":{"message":"Request body exceeds maximum normalization size","type":"invalid_request_error","param":null,"code":"request_body_too_large"}}
  ```

  ```json
  {"type":"error","error":{"type":"invalid_request_error","message":"Request body exceeds maximum normalization size"}}
  ```

- [x] **Step 2: Define unknown-length handling**

  Require a counted `ReadableStream` read when `Content-Length` is absent or invalid. Accumulate no more than the limit, cancel the inbound reader as soon as the next chunk would exceed it, return the same `413` envelope, and never call upstream. Preserve raw streaming for legacy, unknown routes, methods, and routes without a normalization policy.

- [x] **Step 3: Add regression cases to the documented test strategy**

  Require tests for exactly `4 MiB`, `4 MiB + 1` with `Content-Length`, `4 MiB + 1` without `Content-Length`, malformed/duplicate length fallback to counted reading, upstream fetch count `0` on rejection, and unchanged legacy streaming.

- [x] **Step 4: Review wording consistency**

  Search the four Markdown files for `512 MB`, `4 MiB`, `normalization`, and `raw forward`; remove wording that treats the platform limit as the application safety bound or permits an unbounded recognized route.

### Task 2: Add real provider acceptance coverage

**Files:**
- Modify: `apps/deno-relay/acceptance_test.ts`
- Modify: `.github/workflows/acceptance.yml`
- Modify: `REQUIREMENTS_AI_GATEWAY_RELAY.md`
- Modify: `docs/superpowers/specs/2026-09-04-universal-ai-gateway-relay-design.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: Protected environment values `RELAY_ACCEPTANCE_ORIGIN`, `RELAY_ACCEPTANCE_GATEWAY_BASE_URL`, `RELAY_ACCEPTANCE_MODEL`, `RELAY_ACCEPTANCE_GATEWAY_TOKEN`, and `RELAY_ACCEPTANCE_COMMAND_CODE_API_KEY`.
- Produces: Real Gateway-to-provider checks using `cf-aig-authorization`, provider `Authorization`, and the configured Custom Provider relay header.

- [x] **Step 1: Write the concrete acceptance fixtures**

  Use the exact safe OpenAI fixture with two disjoint object branches:

  ```json
  {"anyOf":[{"type":"object","properties":{"query":{"type":"string"}}},{"type":"object","properties":{"limit":{"type":"integer"}}}]}
  ```

  Place it under `tools[].function.parameters` for `/v1/chat/completions` and under `tools[].input_schema` for `/v1/messages`. Keep the Anthropic root `anyOf` unchanged by asserting only a successful provider response, not a locally rewritten body.

- [x] **Step 2: Add protected tests**

  Send requests to `${RELAY_ACCEPTANCE_GATEWAY_BASE_URL}/custom-command-code/v1/chat/completions`, `/v1/messages`, and `/v1/models`. Require 2xx for the concrete OpenAI and Anthropic fixtures, require exact route-specific `400` envelopes for malformed JSON, require models success, and use the standard `Authorization` only for the Command Code key. Do not print response bodies or secret values.

- [x] **Step 3: Make missing configuration fail in the protected workflow**

  Expose the three variables and two secrets through the `protected-acceptance` job, validate their presence without printing values, remove the current skip step, and run the acceptance test unconditionally after validation. Local `deno test apps/deno-relay` may continue to ignore network acceptance when `RELAY_ACCEPTANCE_ORIGIN` is absent.

### Task 3: Verify and publish the fixes

**Files:**
- Verify: `REQUIREMENTS_AI_GATEWAY_RELAY.md`
- Verify: `README.md`
- Verify: `docs/superpowers/specs/2026-09-04-universal-ai-gateway-relay-design.md`
- Verify: `apps/deno-relay/acceptance_test.ts`
- Verify: `.github/workflows/acceptance.yml`

**Interfaces:**
- Consumes: The updated body-limit and protected-acceptance contracts.
- Produces: A clean local verification record and one pushed Japanese Conventional Commit.

- [x] **Step 1: Run local verification**

  Run `deno fmt --check apps/deno-relay`, `deno lint`, `deno test apps/deno-relay`, `cd packages/opencode-plugin && npm run typecheck && npm test && npm run build`, and a YAML/Markdown consistency search. Do not run protected acceptance without its real protected variables.

- [x] **Step 2: Inspect the intended diff**

  Use `git status`, `git diff`, and `git diff --check`; stage only the intended tracked files and leave `.gitignore`, `REQUIREMENTS_2026-08-20.md`, `packages/opencode-plugin/dist/`, and `packages/opencode-plugin/node_modules/` untouched.

- [x] **Step 3: Commit and push**

  Create a Japanese Conventional Commit describing the safety and acceptance contract fix, then push the current feature branch without force. Do not commit directly to `master` and do not merge a pull request.
