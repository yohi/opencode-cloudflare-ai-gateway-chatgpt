# Universal AI Gateway Relay Contract Fix Implementation Plan

> **For agentic workers:** Execute this plan inline in the current session. Do not dispatch subagents.

**Goal:** Align the universal relay's documented status policy, provider-specific schema normalization contract, memory bound, and protected acceptance requirements with the validated review findings before the universal relay implementation begins.

**Architecture:** Keep the existing legacy `POST /v1/responses` behavior unchanged. The future generic relay will pass through upstream `304 Not Modified` responses, reject every other 3xx status without following it, and retain conditional request headers. Its schema normalizer will receive the provider route shape explicitly: OpenAI may use the existing safe root `anyOf` flattening, while Anthropic preserves root `anyOf` schemas byte-for-byte. Recognized JSON normalization routes have a fixed 4 MiB body bound with fail-closed `413` handling. Protected acceptance uses concrete provider-facing fixtures through Cloudflare AI Gateway, Deno Deploy, and Command Code. This change updates the requirements, design, README, and acceptance contract only; it does not add generic relay runtime code that is not yet present.

**Tech Stack:** Markdown requirements and design documents, Deno relay test strategy, GitHub-flavored Markdown.

## Global Constraints

- Preserve the existing legacy `POST /v1/responses` contract, including redirect pass-through.
- For generic `/upstream/*`, set `RequestInit.redirect` to `"manual"`, pass through `304`, and reject all other 3xx statuses with the stable `502` error envelope.
- Retain `If-None-Match` and `If-Modified-Since`; do not introduce a cache or redirect follow.
- Apply root `anyOf` flattening only to the OpenAI `/v1/chat/completions` schema shape.
- Preserve Anthropic `/v1/messages` root `anyOf` schemas, including all members and request-body byte spans, without normalization.
- Keep generic relay behavior fail-closed and avoid direct ChatGPT fallbacks, retry loops, caching, and payload persistence.
- Keep `apps/deno-relay` free of runtime dependencies.
- Preserve raw/token-level bytes outside explicitly normalized schema spans.
- Fix `MAX_NORMALIZATION_BODY_BYTES` at `4 * 1024 * 1024` for recognized JSON normalization routes; do not expose an override that can exceed it.
- Reject oversized recognized bodies before upstream fetch, count bytes when `Content-Length` is unavailable or invalid, and cancel the reader at the first exceeding chunk.
- Protected acceptance must use a concrete safe root `anyOf` fixture against the real provider; missing protected variables must fail the workflow instead of skipping.
- Do not add relay implementation ahead of the existing design-only scope.

---

### Task 1: Fix the generic response status contract

**Files:**
- Modify: `REQUIREMENTS_AI_GATEWAY_RELAY.md:265-280, 394-445`
- Modify: `docs/superpowers/specs/2026-09-04-universal-ai-gateway-relay-design.md:139-160, 309-337, 431-445`
- Modify: `README.md:128-164`

**Interfaces:**
- Consumes: Existing route-specific redirect policy and `RequestInit.redirect: "manual"` requirement.
- Produces: One status policy for all future generic relay implementations and tests.

- [x] **Step 1: Define the status partition**

  State that generic `/upstream/*` passes through upstream `304 Not Modified`, including sanitized response headers and body. State that generic `/upstream/*` converts every other 3xx status, including `300`, `301`, `302`, `303`, `305`, `306`, `307`, and `308`, to `502 {"error":"upstream_redirect_not_allowed"}` without forwarding upstream headers/body or performing another fetch. Keep legacy `/v1/responses` 3xx pass-through unchanged.

- [x] **Step 2: Define conditional-request behavior**

  State that `If-None-Match` and `If-Modified-Since` are ordinary request headers and are not removed by the relay's denylist. Add the `GET /upstream/command-code/v1/models` conditional request case to the integration test strategy, asserting one upstream fetch and a downstream `304` with the validator response preserved.

- [x] **Step 3: Add the complete status matrix**

  Update the design error table and requirements test list so that the generic cases cover `300`, representative redirect statuses (`301`, `302`, `303`, `307`, `308`), `304` pass-through, absolute cross-origin/same-provider and relative `Location`, and the legacy `302`/`307` compatibility exception.

### Task 2: Make schema normalization route-explicit

**Files:**
- Modify: `REQUIREMENTS_AI_GATEWAY_RELAY.md:191-240, 394-474`
- Modify: `docs/superpowers/specs/2026-09-04-universal-ai-gateway-relay-design.md:94-96, 175-233, 394-429`
- Modify: `README.md:130-144`

**Interfaces:**
- Consumes: Existing OpenAI safe-flatten rules, Anthropic no-flatten rules, and raw/token-preserving body contract.
- Produces: A route-explicit normalizer contract that a future `schema.ts` implementation can consume without inferring provider behavior from detected member names.

- [x] **Step 1: Name the route policy**

  Require the future normalizer to receive the recognized route policy from the provider preset. The policy must select exactly one target member: OpenAI `/v1/chat/completions` selects `tools[].function.parameters` and allows safe root `anyOf` flattening; Anthropic `/v1/messages` selects `tools[].input_schema` and never allows root `anyOf` flattening.

- [x] **Step 2: Preserve Anthropic root `anyOf` completely**

  State that an Anthropic target schema containing root `anyOf` skips `type` and `properties` completion as well as flattening. The `anyOf`, every branch, every schema member, and the corresponding UTF-8 request-body byte span must remain unchanged. A route that only contains an `input_schema` member must not be normalized through the OpenAI policy.

- [x] **Step 3: Bound OpenAI fallback behavior**

  State that an OpenAI root `anyOf` is flattened only after all existing safety conditions pass. If it cannot be flattened, skip the whole target schema normalization, including `type` and `properties` completion, while allowing independent safe target schemas in the same body to be normalized.

- [x] **Step 4: Expand the schema test strategy**

  Require separate OpenAI and Anthropic fixtures for safe root `anyOf`, mixed `string | object` root `anyOf`, branch/root constraints, explicit root `type`, route-shape mismatch, and raw UTF-8 byte equality. Keep ordinary `type`/`properties` completion tests for both routes only when root `anyOf` is absent.

### Task 3: Verify and publish the documentation contract fix

**Files:**
- Test strategy references: `apps/deno-relay/*_test.ts`
- Verify: `REQUIREMENTS_AI_GATEWAY_RELAY.md`, `README.md`, `docs/superpowers/specs/2026-09-04-universal-ai-gateway-relay-design.md`, this plan

- [x] **Step 1: Search for stale contradictory wording**

  Search the tracked Markdown files for generic `all 3xx` wording and provider-agnostic `anyOf` flattening wording. Replace every occurrence that contradicts the `304` exception or route-explicit schema policy; do not alter unrelated legacy compatibility text.

- [x] **Step 2: Run repository verification**

  Run `deno test apps/deno-relay`, `deno fmt --check`, `deno lint`, `npm ci --legacy-peer-deps`, `npm run typecheck`, `npm test`, and `npm run build`. Record protected acceptance as not run if its required environment variables or credentials are unavailable. The full repository `deno fmt --check` may still report unrelated unformatted workspace files; the intended Markdown files must be checked separately and the unrelated files must not be changed as part of this fix.

- [x] **Step 3: Inspect intended changes only**

  Review `git status`, `git diff`, and `git log --oneline -10`. Stage only the four intended tracked Markdown files and leave unrelated untracked files such as `.gitignore`, `REQUIREMENTS_2026-08-20.md`, `packages/opencode-plugin/dist/`, and `packages/opencode-plugin/node_modules/` untouched.

- [x] **Step 4: Commit and push the contract fix**

  Create one Japanese Conventional Commit for the requirements/design contract correction, then push the current feature branch without force. Do not commit directly to `master` and do not merge a pull request.

### Task 4: Follow-up safety and protected acceptance contract

**Files:**
- Modify: `REQUIREMENTS_AI_GATEWAY_RELAY.md`
- Modify: `docs/superpowers/specs/2026-09-04-universal-ai-gateway-relay-design.md`
- Modify: `README.md`
- Modify: `apps/deno-relay/acceptance_test.ts`
- Modify: `.github/workflows/acceptance.yml`

**Interfaces:**
- Consumes: The route-explicit normalizer contract and `protected-acceptance` environment.
- Produces: A fixed 4 MiB body safety contract and provider-facing acceptance coverage.

- [x] **Step 1: Add the 4 MiB normalization bound**

  Require `Content-Length` early rejection and counted-reader cancellation for recognized JSON routes, route-specific `413` envelopes, zero upstream fetches, and unchanged legacy/unknown-route streaming.

- [x] **Step 2: Add a concrete provider fixture**

  Require the disjoint object-branch root `anyOf` fixture under OpenAI `tools[].function.parameters` and Anthropic `tools[].input_schema`, with the former flattened only by the OpenAI policy and the latter preserved.

- [x] **Step 3: Add executable protected acceptance**

  Add real Gateway URL requests for OpenAI, Anthropic, and models, route-specific malformed JSON checks, secret-free failure messages, and a workflow preflight that fails when any required variable or secret is absent.
