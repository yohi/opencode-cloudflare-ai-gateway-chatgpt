# Universal AI Gateway Relay anyOf Contract Fix Implementation Plan

> **For agentic workers:** Execute this plan inline in the current session. Do not dispatch subagents.

**Goal:** Make unsafe root-level `anyOf` handling consistent with the no-semantic-corruption contract before relay implementation begins.

**Architecture:** Keep safe `anyOf` flattening and ordinary `type`/`properties` completion unchanged. When a target schema contains an `anyOf` that cannot be safely flattened, skip every schema normalization for that target schema and preserve its original body byte span. Independent safe target schemas in the same request may still be normalized. Document and test this decision consistently in the requirements, detailed design, and README.

**Tech Stack:** Markdown design documents, Deno relay test strategy.

## Global Constraints

- Preserve the existing legacy `POST /v1/responses` contract.
- Keep generic relay behavior fail-closed and avoid direct ChatGPT fallbacks, retry loops, caching, and payload persistence.
- Keep `apps/deno-relay` free of runtime dependencies.
- Preserve raw/token-level bytes outside explicitly normalized schema spans.
- Do not add relay implementation ahead of the design-only scope.

---

### Task 1: Define the unsafe `anyOf` normalization contract

**Files:**
- Modify: `REQUIREMENTS_AI_GATEWAY_RELAY.md:171-200`
- Modify: `docs/superpowers/specs/2026-09-04-universal-ai-gateway-relay-design.md:199-221`

**Interfaces:**
- Consumes: Existing safe-flatten conditions and `type`/`properties` completion rules.
- Produces: A single rule stating that an unflattened root `anyOf` skips all normalization for that target schema.

- [x] **Step 1: Rewrite both normalization sections**

  State that `type: "object"` and `properties: {}` completion occurs only when the target schema has no root `anyOf`, or after the root `anyOf` has passed the safe-flatten decision. If a root `anyOf` fails that decision, retain the complete target schema and its body byte span unchanged; do not add, remove, or rewrite any member.

- [x] **Step 2: Add the mixed-type counterexample to both contracts**

  Include a concise example where `anyOf` contains `type: "string"` and `type: "object"`, explaining that adding a root `type: "object"` would invalidate the string branch.

### Task 2: Align test strategy and README

**Files:**
- Modify: `REQUIREMENTS_AI_GATEWAY_RELAY.md:344-361`
- Modify: `docs/superpowers/specs/2026-09-04-universal-ai-gateway-relay-design.md:369-464`
- Modify: `README.md:130-149`

**Interfaces:**
- Consumes: The unified unsafe `anyOf` rule from Task 1.
- Produces: Test cases and user-facing documentation that distinguish safe flattening, unsafe no-op behavior, and ordinary completion.

- [x] **Step 1: Strengthen schema test cases**

  Require complete no-op behavior for mixed-type `anyOf`, branch-constrained `anyOf`, root-constrained `anyOf`, and explicit-root-type cases. Require UTF-8 raw-byte equality for the skipped target schema span, not only deep equality after parsing. A fixture containing only that target schema must preserve the entire body; a multi-tool fixture must not prevent independent safe schemas from being normalized.

- [x] **Step 2: Update README relay behavior**

  Document that generic route normalization does not add `type` or `properties` when a root `anyOf` is not safely flattenable, preventing the README from implying unconditional completion.

### Task 3: Verify the documentation-only change

**Files:**
- Test: `apps/deno-relay/*_test.ts`

- [x] **Step 1: Run relay tests and static checks**

  Run `deno test apps/deno-relay`, `deno fmt --check apps/deno-relay`, and `deno lint`.

- [x] **Step 2: Inspect the final diff and repository status**

  Confirm that only the plan and intended documentation files changed, with no relay source implementation added.

- [ ] **Step 3: Commit and push the documentation fix**

  After checking `git status`, `git diff`, and recent history, create one Japanese Conventional Commit containing the plan and documentation updates, then push the current feature branch without force.
