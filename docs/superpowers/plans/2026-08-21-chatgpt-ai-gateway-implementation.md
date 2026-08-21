# ChatGPT AI Gateway (Plugin + Relay) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
superpowers:subagent-driven-development (recommended) or
superpowers:executing-plans to implement this plan task-by-task. Steps use
checkbox (`- [ ]`) syntax for tracking.
>
> Execute inside an isolated worktree created via
superpowers:using-git-worktrees. All work is delivered as **6 stacked PRs** (see
"Stacked PR Strategy"). Never push directly to `master`; merging is reserved for
human operators.

**Goal:** Ship `@yohi/cloudflare-ai-gateway-chatgpt` (OpenCode plugin) and the
Deno Deploy egress relay so ChatGPT Codex traffic from OpenCode is routed
through Cloudflare AI Gateway with fail-closed semantics.

**Architecture:** The plugin interposes `globalThis.fetch` for exactly one
request (`POST https://chatgpt.com/backend-api/codex/responses`), rewrites its
URL to a Cloudflare AI Gateway Custom Provider path, and adds Gateway/relay
control headers. The relay accepts only `POST /v1/responses`, validates a bearer
token, sanitizes hop-by-hop headers, and streams to the fixed ChatGPT upstream.
The two deliverables share no runtime library; their only coupling is the
documented HTTP contract.

**Tech Stack:** Deno 2 (relay, workspace member), TypeScript + vitest + Node 22
(plugin npm package), GitHub Actions (CI), gh-stack (stacked PRs).

Spec: `docs/superpowers/specs/2026-08-20-chatgpt-ai-gateway-design.md`

## Global Constraints

Every task implicitly includes these. Values are copied verbatim from the spec.

- Intercepted request: exactly `POST
  https://chatgpt.com/backend-api/codex/responses`. Nothing else is intercepted,
  transformed, or blocked.
- Gateway URL template:
  `{gatewayBaseUrl}/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/custom-{providerSlug}/v1/responses`.
- Control headers added on matching requests: `cf-aig-authorization: Bearer
  <Gateway token>`, `X-ChatGPT-Relay-Authorization: Bearer <relay token>`,
  `cf-aig-collect-log: true`, `cf-aig-collect-log-payload: <true|false>`,
  `cf-aig-metadata:
  {"source":"opencode","auth_type":"chatgpt_subscription","plugin":"cloudflare-ai-gateway-chatgpt"}`,
  `cf-aig-skip-cache: true`, `cf-aig-max-attempts: 1`.
- Config resolution: Account ID = env `CLOUDFLARE_ACCOUNT_ID` (required).
  Gateway ID = env `CLOUDFLARE_GATEWAY_ID` (required). Gateway token =
  `CLOUDFLARE_API_TOKEN` → `CF_AIG_TOKEN` → plugin `apiKey`. Relay token =
  `CLOUDFLARE_CHATGPT_RELAY_TOKEN` → plugin `relayToken`. Provider slug =
  `CLOUDFLARE_CHATGPT_PROVIDER_SLUG` → plugin `providerSlug` → default
  `chatgpt-codex-deno`. Log payload = `CLOUDFLARE_AIG_COLLECT_LOG_PAYLOAD` (only
  exact lowercase `true`/`false`) → plugin boolean `collectLogPayload` → default
  `true`.
- Gateway base URL: production `https://gateway.ai.cloudflare.com`. Override via
  `CLOUDFLARE_AIG_BASE_URL` only when `CLOUDFLARE_AIG_TEST_MODE` is exactly
  `true` and the parsed URL origin equals the allowlisted HTTPS origin
  `https://gateway.test.invalid`; otherwise it is a matching-request
  configuration error.
- Fail closed: missing/invalid configuration throws only for matching Codex
  requests and never falls back to direct ChatGPT access. OAuth,
  `auth.openai.com`, `api.openai.com`, other `chatgpt.com` traffic pass through
  unchanged.
- Plugin activation gate: reject activation before installing the interposer
  when the host version capability is absent or outside the supported range.
  Supported range constant: `">=1.19.0 <2"`, identical to
  `peerDependencies.opencode`.
- Relay timeouts: 30-second connect-and-response-header timeout returning `504`
  with exact body `{"error":"upstream_connect_or_header_timeout"}`; separate
  120-second SSE idle timer that resets only on body chunks and terminates the
  stream with error `upstream_sse_idle_timeout`.
- Relay header denylist removal: `cf-aig-*`, `cf-*`, `x-forwarded-*`,
  `forwarded`, `x-real-ip`, `x-chatgpt-relay-authorization`, `host`,
  `content-length`, `connection`, `keep-alive`, `proxy-authenticate`,
  `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`, plus
  every header named by the request `Connection` token list. Response filtering
  removes `Connection`, its nominated names, and the standard hop-by-hop set.
- No fallback, retry loop, cache, payload persistence, or logging of
  credentials/payloads anywhere. Diagnostics never contain tokens, prompts, or
  responses.
- Runtime dependencies: plugin may depend only on `semver`; relay has zero
  runtime dependencies.
- Git: Japanese Conventional Commits; no direct commits/pushes to `master`; PRs
  are merged only by humans; PRs are stacked bottom-up.

## Stacked PR Strategy

All tasks are grouped into 6 stacked PRs. Each PR builds directly on the
previous one and must be reviewable/mergeable independently in order. Use the
`gh-stack` skill for stack mechanics.

1. Branch `chore/monorepo-workspace`, base `master`, tasks 1–2 —
   "chore: Denoワークスペース構成へ移行"
2. Branch `feat/relay-stream-semantics`, base PR #1, tasks 3–4 —
   "feat: relayのSSEストリーム意味論を実装"
3. Branch `feat/plugin-core-modules`, base PR #2, tasks 5–8 —
   "feat: プラグインコアモジュールを追加"
4. Branch `feat/plugin-fetch-interposer`, base PR #3, tasks 9–11 —
   "feat: fetchインターポーザーとプラグインエントリを追加"
5. Branch `test/byok-load-order-contract`, base PR #4, task 12 —
   "test: BYOK両ロード順コントラクトテストを追加"
6. Branch `chore/ci-and-docs`, base PR #5, tasks 13–14 —
   "chore: CIワークフローとドキュメントを整備"

Stack workflow rules:

1. Create branches bottom-up: branch N+1 is cut from branch N. Push all, then
   open PRs so that PR N+1 targets branch N (PR 1 targets `master`).
2. A human merges PR N. After each merge, restack: rebase the remaining stack
   onto updated `master` and retarget the new bottom PR to `master` (with
   gh-stack CLI: `gh stack sync --restack`; manually: `git rebase --onto master
   <merged-branch> <next-branch>` per remaining branch).
3. Agents never merge, never force-push shared branches without restacking,
   never skip CI-green verification before requesting review.
4. Release note: publishing the npm package remains **blocked** until OpenCode
   ships the host version capability (spec Decisions). Task 14 documents this in
   the release checklist.

---

## PR #1 — chore/monorepo-workspace

### Task 1: Move relay into `apps/deno-relay` and create the Deno workspace

**Files:**

- Create: `deno.json` (overwrite existing root config)
- Create: `apps/deno-relay/deno.json`
- Move: `main.ts` → `apps/deno-relay/main.ts`
- Move: `relay.ts` → `apps/deno-relay/relay.ts`
- Move: `relay_test.ts` → `apps/deno-relay/relay_test.ts`

**Interfaces:**

- Consumes: nothing (first task).
- Produces: workspace layout where `deno test`, `deno lint`, `deno fmt --check`
  run from repo root over `apps/deno-relay`; relay entry exports
  `createRelayHandler(dependencies)` unchanged (later tasks extend
  `RelayDependencies`).

- [ ] **Step 1: Move files with git mv**

```bash
mkdir -p apps/deno-relay
git mv main.ts relay.ts relay_test.ts apps/deno-relay/
```

- [ ] **Step 2: Overwrite root `deno.json`**

Replace the entire content of `deno.json` with:

```json
{
  "workspace": ["apps/deno-relay"],
  "fmt": {
    "exclude": ["packages", ".omo", ".justice"]
  },
  "lint": {
    "exclude": ["packages", ".omo", ".justice"]
  }
}
```

- [ ] **Step 3: Create `apps/deno-relay/deno.json`**

```json
{
  "tasks": {
    "start": "deno run --allow-net --allow-env main.ts",
    "test": "deno test"
  }
}
```

- [ ] **Step 4: Verify tests still pass from the root**

Run: `deno test`
Expected: PASS — all 5 tests in `apps/deno-relay/relay_test.ts`.

- [ ] **Step 5: Verify fmt and lint are clean**

Run: `deno fmt --check && deno lint`
Expected: no output, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add deno.json apps/deno-relay/
git commit -m "chore: Denoワークスペース構成へrelayを移動"
```

### Task 2: Root README skeleton

**Files:**

- Create: `README.md`

**Interfaces:**

- Consumes: nothing.
- Produces: repository entry point documenting the two deliverables; expanded in
  Task 14.

- [ ] **Step 1: Create `README.md`**

````markdown
# opencode-cloudflare-ai-gateway-chatgpt

OpenCode の ChatGPT Codex 通信を Cloudflare AI Gateway 経由で観測可能にするリポジトリ。

## 構成

- `packages/opencode-plugin`: npm パッケージ `@yohi/cloudflare-ai-gateway-chatgpt`(実装予定)
- `apps/deno-relay`: Deno Deploy 固定アップストリーム egress relay

## 経路

```text
OpenCode built-in ChatGPT OAuth
  -> plugin fetch interposer
  -> Cloudflare AI Gateway Custom Provider
  -> Deno Deploy relay
  -> https://chatgpt.com/backend-api/codex/responses
```

## 開発

```bash
deno test        # relay のテスト
deno lint        # lint
deno fmt --check # フォーマット検査
```

設計詳細は `docs/superpowers/specs/2026-08-20-chatgpt-ai-gateway-design.md` を参照。
````

- [ ] **Step 2: Verify docs render and tree is correct**

Run: `ls apps/deno-relay && deno test`
Expected: `deno.json main.ts relay.ts relay_test.ts` listed; tests PASS.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: ルートREADMEの骨子を追加"
```

---

## PR #2 — feat/relay-stream-semantics

### Task 3: SSE idle timeout (120 seconds)

**Files:**

- Modify: `apps/deno-relay/relay.ts`
- Test: `apps/deno-relay/relay_test.ts`

**Interfaces:**

- Consumes: `createRelayHandler(dependencies)`, `RelayTimer` (existing exports).
- Produces: `RelayDependencies` gains optional `idleTimeoutMs?: number` (default
  `120_000`). SSE responses (upstream `content-type` containing
  `text/event-stream`) stream through an idle-timeout wrapper: timer starts
  after upstream headers arrive, resets only on body chunks, aborts upstream and
  errors the downstream stream with `Error("upstream_sse_idle_timeout")` on
  expiry. Non-SSE responses are untouched.

- [ ] **Step 1: Write failing tests**

Append to `apps/deno-relay/relay_test.ts`:

```typescript
Deno.test("errors an SSE stream when the idle timer expires", async () => {
  type Scheduled = { id: number; callback: () => void };
  const scheduled: Scheduled[] = [];
  let nextId = 1;
  let upstreamAborted = false;

  const handler = createRelayHandler({
    getSecret: () => relayToken,
    fetcher: (_input, init) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          upstreamAborted = true;
        },
        { once: true },
      );
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("event: response.created\n\n"));
        },
      });
      return Promise.resolve(
        new Response(body, { headers: { "content-type": "text/event-stream" } }),
      );
    },
    timer: {
      schedule: (callback, _delayMs) => {
        const id = nextId++;
        scheduled.push({ id, callback });
        return id;
      },
      clear: (id) => {
        const index = scheduled.findIndex((entry) => entry.id === id);
        if (index >= 0) {
          scheduled.splice(index, 1);
        }
      },
    },
  });

  const response = await handler(createRequest());
  assertEquals(
    response.headers.get("content-type"),
    "text/event-stream",
    "sse content type",
  );

  const reader = response.body!.getReader();
  const first = await reader.read();
  assert(first.value !== undefined, "first chunk received");
  assertEquals(scheduled.length, 1, "only the idle timer remains scheduled");

  scheduled[0].callback();

  let errorMessage = "";
  try {
    await reader.read();
  } catch (error) {
    errorMessage = (error as Error).message;
  }
  assertEquals(errorMessage, "upstream_sse_idle_timeout", "idle timeout stream error");
  assert(upstreamAborted, "upstream aborted");
});

Deno.test("resets the SSE idle timer per chunk", async () => {
  let scheduleCalls = 0;
  const clearedIds: number[] = [];

  const handler = createRelayHandler({
    getSecret: () => relayToken,
    fetcher: () => {
      const encoder = new TextEncoder();
      const chunks = ["a", "b"];
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = chunks.shift();
          if (next === undefined) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(next));
        },
      });
      return Promise.resolve(
        new Response(body, { headers: { "content-type": "text/event-stream" } }),
      );
    },
    timer: {
      schedule: () => ++scheduleCalls,
      clear: (id) => {
        clearedIds.push(id);
      },
    },
  });

  const response = await handler(createRequest());
  const text = await response.text();

  assertEquals(text, "ab", "streamed body");
  assertEquals(scheduleCalls, 4, "header timeout + initial idle + reset per chunk");
  assertEquals(clearedIds.length, 4, "every scheduled timer was cleared");
});

Deno.test("does not impose an idle timer on non-SSE responses", async () => {
  let scheduleCalls = 0;

  const handler = createRelayHandler({
    getSecret: () => relayToken,
    fetcher: () =>
      Promise.resolve(
        new Response("upstream-body", {
          headers: { "content-type": "application/json" },
        }),
      ),
    timer: {
      schedule: () => ++scheduleCalls,
      clear: () => undefined,
    },
  });

  const response = await handler(createRequest());

  assertEquals(await response.text(), "upstream-body", "response body");
  assertEquals(scheduleCalls, 1, "only the header timeout was scheduled");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test`
Expected: FAIL — `idleTimeoutMs` unknown property is ignored, SSE streams hang
or complete without the wrapper; the three new tests fail (timeout/error
assertions).

- [ ] **Step 3: Implement the idle-timeout stream in `relay.ts`**

Add below the existing constants:

```typescript
const sseIdleTimeoutMs = 120_000;
const sseContentTypeMarker = "text/event-stream";
```

Add above `createRelayHandler`:

```typescript
function createSseIdleTimeoutStream(
  upstreamBody: ReadableStream<Uint8Array>,
  options: {
    readonly controller: AbortController;
    readonly timer: RelayTimer;
    readonly idleTimeoutMs: number;
  },
): ReadableStream<Uint8Array> {
  const reader = upstreamBody.getReader();
  let downstream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let streamSettled = false;
  let idleTimedOut = false;
  let timerId = 0;

  const clearIdleTimer = (): void => {
    options.timer.clear(timerId);
  };

  const settleDownstream = (error: unknown): void => {
    if (streamSettled || downstream === undefined) {
      return;
    }
    streamSettled = true;
    clearIdleTimer();
    try {
      downstream.error(error);
    } catch {
      void error;
    }
  };

  const scheduleIdleTimer = (): number =>
    options.timer.schedule(() => {
      idleTimedOut = true;
      options.controller.abort();
      settleDownstream(new Error("upstream_sse_idle_timeout"));
    }, options.idleTimeoutMs);

  timerId = scheduleIdleTimer();

  const resetIdleTimer = (): void => {
    clearIdleTimer();
    timerId = scheduleIdleTimer();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      downstream ??= controller;
    },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          streamSettled = true;
          clearIdleTimer();
          controller.close();
          return;
        }
        resetIdleTimer();
        controller.enqueue(result.value);
      } catch (error) {
        if (idleTimedOut) {
          settleDownstream(new Error("upstream_sse_idle_timeout"));
          return;
        }
        settleDownstream(
          error instanceof Error ? error : new Error("upstream_stream_error"),
        );
      }
    },
    async cancel(reason) {
      streamSettled = true;
      clearIdleTimer();
      try {
        await reader.cancel(reason);
      } catch {
        void reason;
      }
      options.controller.abort();
    },
  });
}
```

Extend `RelayDependencies`:

```typescript
export type RelayDependencies = {
  readonly fetcher: RelayFetcher;
  readonly getSecret: () => string | undefined;
  readonly timer?: RelayTimer;
  readonly timeoutMs?: number;
  readonly idleTimeoutMs?: number;
};
```

Inside `createRelayHandler`, resolve the default next to `timeoutMs`:

```typescript
const idleTimeoutMs = dependencies.idleTimeoutMs ?? sseIdleTimeoutMs;
```

Replace the success-path return block of the handler:

```typescript
      const contentType = upstream.headers.get("content-type") ?? "";
      const body =
        contentType.includes(sseContentTypeMarker) && upstream.body !== null
          ? createSseIdleTimeoutStream(upstream.body, {
            controller,
            timer,
            idleTimeoutMs,
          })
          : upstream.body;

      return new Response(body, {
        status: upstream.status,
        headers: sanitizeResponseHeaders(upstream.headers),
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test`
Expected: PASS — all 8 tests (5 existing + 3 new).

- [ ] **Step 5: Verify fmt/lint and commit**

```bash
deno fmt --check && deno lint
git add apps/deno-relay/
git commit -m "feat: SSEアイドルタイムアウト(120秒)を追加"
```

### Task 4: Post-header cancellation semantics

**Files:**

- Modify: `apps/deno-relay/relay.ts` — the inbound abort listener is removed in
  the `finally` block as soon as the fetcher resolves, so post-header client
  disconnects never reach the upstream fetch. Keep the listener attached and
  detach it only when the SSE body settles.
- Test: `apps/deno-relay/relay_test.ts`

**Interfaces:**

- Consumes: `createSseIdleTimeoutStream` (extended with an optional completion
  hook), the existing inbound `request.signal` → upstream `AbortController`
  link.
- Produces: verified guarantees — downstream `cancel()` cancels the upstream
  body and aborts the upstream fetch; the inbound client-abort listener stays
  attached after headers arrive and is detached only when the SSE body closes,
  errors, or is cancelled, so a late client disconnect still propagates to the
  upstream fetch. No public signature changes.

- [ ] **Step 1: Write failing tests**

Append to `apps/deno-relay/relay_test.ts`:

```typescript
Deno.test("cancels the upstream body when the downstream cancels", async () => {
  let upstreamCancelled = false;
  let upstreamSignalAborted = false;

  const handler = createRelayHandler({
    getSecret: () => relayToken,
    fetcher: (_input, init) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          upstreamSignalAborted = true;
        },
        { once: true },
      );
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(encoder.encode("event: response.created\n\n"));
        },
        cancel() {
          upstreamCancelled = true;
        },
      });
      return Promise.resolve(
        new Response(body, { headers: { "content-type": "text/event-stream" } }),
      );
    },
  });

  const response = await handler(createRequest());
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel("client gone");

  assert(upstreamCancelled, "upstream body cancelled");
  assert(upstreamSignalAborted, "upstream fetch aborted");
});

Deno.test("aborts upstream on late client disconnect", async () => {
  let upstreamSignal: AbortSignal | undefined;
  const clientController = new AbortController();

  const handler = createRelayHandler({
    getSecret: () => relayToken,
    fetcher: (_input, init) => {
      upstreamSignal = init?.signal ?? null;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("event: response.created\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    },
  });

  const request = new Request("https://relay.example/v1/responses", {
    method: "POST",
    headers: { "X-ChatGPT-Relay-Authorization": relayAuthorization },
    body: "request-body",
    signal: clientController.signal,
  });
  const response = await handler(request);
  clientController.abort();

  assert(upstreamSignal?.aborted === true, "upstream fetch aborted by client disconnect");
});
```

The second test asserts immediately after `clientController.abort()` without
cancelling the response body first, so it can only pass via the inbound abort
listener itself — not through the wrapper's `cancel()` path.

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test`
Expected: FAIL — `aborts upstream on late client disconnect` fails because the
current `finally` block removes the abort listener once the fetcher resolves.
`cancels the upstream body when the downstream cancels` already passes via the
wrapper's `cancel()` path.

- [ ] **Step 3: Implement the abort-listener lifetime fix in `relay.ts`**

Extend `createSseIdleTimeoutStream` options with an optional completion hook:

```typescript
  options: {
    readonly controller: AbortController;
    readonly timer: RelayTimer;
    readonly idleTimeoutMs: number;
    readonly onFinished?: () => void;
  },
```

Introduce a single settlement helper inside the function and route every
shutdown path through it:

```typescript
  const finishStream = (): void => {
    if (streamSettled) {
      return;
    }
    streamSettled = true;
    clearIdleTimer();
    options.onFinished?.();
  };

  const settleDownstream = (error: unknown): void => {
    if (downstream === undefined) {
      return;
    }
    finishStream();
    try {
      downstream.error(error);
    } catch {
      void error;
    }
  };
```

In the `pull()` done path, replace the manual flag set and timer clear with
`finishStream();` immediately before `controller.close();`. In `cancel()`, call
`finishStream();` first instead of setting the flag manually.

Wire the hook in `createRelayHandler` so the SSE wrapper detaches the inbound
abort listener when its body settles:

```typescript
      const detachClientAbortListener = (): void => {
        request.signal.removeEventListener("abort", abortForClientDisconnect);
      };

      const contentType = upstream.headers.get("content-type") ?? "";
      const body =
        contentType.includes(sseContentTypeMarker) && upstream.body !== null
          ? createSseIdleTimeoutStream(upstream.body, {
            controller,
            timer,
            idleTimeoutMs,
            onFinished: detachClientAbortListener,
          })
          : upstream.body;
```

Remove the `removeEventListener` line from the `finally` block (keep the timer
clear). `{ once: true }` already bounds the listener to a single invocation.
Non-SSE responses and pre-body failure paths (504 JSON response, thrown
fetcher error) leave the listener attached until the Request object is
garbage-collected, which satisfies the detach-only-on-SSE-settlement rule and
costs nothing extra at runtime.

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test`
Expected: PASS — all 10 tests (5 existing + 3 from Task 3 + 2 here).

- [ ] **Step 5: Verify full suite, fmt, lint and commit**

```bash
deno test && deno fmt --check && deno lint
git add apps/deno-relay/
git commit -m "fix: ヘッダー受信後のクライアント切断を上流fetchへ伝播"
```

---

## PR #3 — feat/plugin-core-modules

### Task 5: Scaffold `packages/opencode-plugin`

**Files:**

- Create: `packages/opencode-plugin/package.json`
- Create: `packages/opencode-plugin/tsconfig.json`
- Create: `packages/opencode-plugin/vitest.config.ts`
- Create: `packages/opencode-plugin/src/index.ts`
- Create: `packages/opencode-plugin/test/smoke.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: npm package `@yohi/cloudflare-ai-gateway-chatgpt` v0.1.0, ESM,
  scripts `build`/`typecheck`/`test`, dependency `semver`, dev tooling
  installed. Later tasks fill `src/index.ts` exports.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@yohi/cloudflare-ai-gateway-chatgpt",
  "version": "0.1.0",
  "description": "Routes ChatGPT Codex traffic through Cloudflare AI Gateway.",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": [
    "dist",
    "README.md"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "prepack": "npm run build"
  },
  "dependencies": {
    "semver": "^7.7.1"
  },
  "peerDependencies": {
    "opencode": ">=1.19.0 <2"
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "@types/semver": "^7.5.8",
    "typescript": "^5.8.0",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Install dependencies including the plugin types package**

```bash
cd packages/opencode-plugin
npm install
npm install --save-dev @opencode-ai/plugin
```

Expected: lockfile created; `@opencode-ai/plugin` resolves to its latest
published version.

- [ ] **Step 5: Create placeholder `src/index.ts` and smoke test**

`src/index.ts`:

```typescript
export const PLUGIN_NAME = "cloudflare-ai-gateway-chatgpt";
```

`test/smoke.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { PLUGIN_NAME } from "../src/index.js";

describe("smoke", () => {
  it("exports the plugin name", () => {
    expect(PLUGIN_NAME).toBe("cloudflare-ai-gateway-chatgpt");
  });
});
```

- [ ] **Step 6: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; 1 test PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/opencode-plugin/
git commit -m "chore: opencode-pluginパッケージの雛形を作成"
```

### Task 6: Error types and host version gate

**Files:**

- Create: `packages/opencode-plugin/src/errors.ts`
- Create: `packages/opencode-plugin/src/host-version.ts`
- Modify: `packages/opencode-plugin/src/index.ts`
- Test: `packages/opencode-plugin/test/host-version.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `class PluginConfigurationError extends Error`, `class
    UnsupportedOpenCodeVersionError extends Error` (both set `name`).
  - `const SUPPORTED_OPENCODE_RANGE = ">=1.19.0 <2"`.
  - `type HostVersionCapability = { readonly available: true; readonly version:
    string } | { readonly available: false }`.
  - `function resolveHostVersionCapability(input: unknown):
    HostVersionCapability` — checks candidate paths `input.opencode.version`,
    `input.opencode` (string), `input.host.version`, `input.version`; first
    value that is a non-empty semver-valid string wins.
  - `function assertSupportedHost(capability: HostVersionCapability): void` —
    throws `UnsupportedOpenCodeVersionError` when absent or out of range.

- [ ] **Step 1: Write failing tests**

Create `test/host-version.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  assertSupportedHost,
  resolveHostVersionCapability,
  SUPPORTED_OPENCODE_RANGE,
} from "../src/host-version.js";
import { UnsupportedOpenCodeVersionError } from "../src/errors.js";

describe("resolveHostVersionCapability", () => {
  it("reads input.opencode.version", () => {
    expect(resolveHostVersionCapability({ opencode: { version: "1.19.0" } })).toEqual({
      available: true,
      version: "1.19.0",
    });
  });

  it("reads a string input.opencode", () => {
    expect(resolveHostVersionCapability({ opencode: "1.20.1" })).toEqual({
      available: true,
      version: "1.20.1",
    });
  });

  it("reads input.host.version and input.version as fallbacks", () => {
    expect(resolveHostVersionCapability({ host: { version: "1.19.2" } })).toEqual({
      available: true,
      version: "1.19.2",
    });
    expect(resolveHostVersionCapability({ version: "2.0.0" })).toEqual({
      available: true,
      version: "2.0.0",
    });
  });

  it("reports absent when no candidate holds a valid semver string", () => {
    expect(resolveHostVersionCapability({})).toEqual({ available: false });
    expect(resolveHostVersionCapability({ opencode: { version: "not-semver" } })).toEqual({
      available: false,
    });
    expect(resolveHostVersionCapability(undefined)).toEqual({ available: false });
  });
});

describe("assertSupportedHost", () => {
  it("throws when the capability is absent", () => {
    expect(() => assertSupportedHost({ available: false })).toThrow(
      UnsupportedOpenCodeVersionError,
    );
  });

  it("throws for versions outside the supported range", () => {
    expect(() =>
      assertSupportedHost({ available: true, version: "1.18.19" }),
    ).toThrow(UnsupportedOpenCodeVersionError);
    expect(() =>
      assertSupportedHost({ available: true, version: "2.1.0" }),
    ).toThrow(UnsupportedOpenCodeVersionError);
  });

  it("accepts boundary versions of the range", () => {
    expect(() =>
      assertSupportedHost({ available: true, version: "1.19.0" }),
    ).not.toThrow();
    expect(() =>
      assertSupportedHost({ available: true, version: "1.99.9" }),
    ).not.toThrow();
  });

  it("keeps the range constant in sync with the documented value", () => {
    expect(SUPPORTED_OPENCODE_RANGE).toBe(">=1.19.0 <2");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/errors.ts`**

```typescript
export class PluginConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginConfigurationError";
  }
}

export class UnsupportedOpenCodeVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedOpenCodeVersionError";
  }
}
```

- [ ] **Step 4: Implement `src/host-version.ts`**

```typescript
import { satisfies, valid } from "semver";
import { UnsupportedOpenCodeVersionError } from "./errors.js";

export const SUPPORTED_OPENCODE_RANGE = ">=1.19.0 <2";

export type HostVersionCapability =
  | { readonly available: true; readonly version: string }
  | { readonly available: false };

function firstValidSemver(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (
      typeof value === "string" &&
      value.length > 0 &&
      valid(value) !== null
    ) {
      return value;
    }
  }
  return undefined;
}

export function resolveHostVersionCapability(
  input: unknown,
): HostVersionCapability {
  const source = (input ?? {}) as Record<string, unknown>;
  const opencode = source.opencode as Record<string, unknown> | string | undefined;
  const host = source.host as Record<string, unknown> | undefined;
  const version = firstValidSemver([
    typeof opencode === "object" && opencode !== null ? opencode.version : undefined,
    typeof opencode === "string" ? opencode : undefined,
    typeof host === "object" && host !== null ? host.version : undefined,
    source.version,
  ]);
  return version === undefined
    ? { available: false }
    : { available: true, version };
}

export function assertSupportedHost(capability: HostVersionCapability): void {
  if (!capability.available) {
    throw new UnsupportedOpenCodeVersionError(
      "cloudflare-ai-gateway-chatgpt: OpenCode did not expose a host" +
        " version capability. Activation rejected; ChatGPT Codex requests" +
        " will fail closed instead of bypassing the AI Gateway.",
    );
  }
  if (!satisfies(capability.version, SUPPORTED_OPENCODE_RANGE)) {
    throw new UnsupportedOpenCodeVersionError(
      `cloudflare-ai-gateway-chatgpt: unsupported OpenCode version ` +
        `${capability.version}. Supported range: ` +
        `${SUPPORTED_OPENCODE_RANGE}.`,
    );
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — smoke + host-version suites.

- [ ] **Step 6: Update `src/index.ts` exports**

```typescript
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
```

Move the placeholder constant into `src/core.ts`:

```typescript
export const PLUGIN_NAME = "cloudflare-ai-gateway-chatgpt";
```

Delete the constant from `src/index.ts` (it now re-exports).

- [ ] **Step 7: Verify and commit**

```bash
npm run typecheck && npm test
git add packages/opencode-plugin/
git commit -m "feat: ホストバージョン判定とエラー型を追加"
```

### Task 7: Configuration resolution

**Files:**

- Create: `packages/opencode-plugin/src/config.ts`
- Modify: `packages/opencode-plugin/src/index.ts`
- Test: `packages/opencode-plugin/test/config.test.ts`

**Interfaces:**

- Consumes: `PluginConfigurationError` from Task 6.
- Produces:
  - `type EnvSource = Readonly<Record<string, string | undefined>>`
  - `type PluginOptions = { readonly apiKey?: unknown; readonly relayToken?:
    unknown; readonly providerSlug?: unknown; readonly collectLogPayload?:
    unknown }`
  - `type ResolvedConfig = { readonly accountId: string; readonly gatewayId:
    string; readonly gatewayToken: string; readonly relayToken: string; readonly
    providerSlug: string; readonly collectLogPayload: boolean; readonly
    gatewayBaseUrl: string }`
  - `const DEFAULT_PROVIDER_SLUG = "chatgpt-codex-deno"`, `const
    PRODUCTION_GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com"`
  - `function resolveConfig(env: EnvSource, options?: PluginOptions):
    ResolvedConfig` — throws `PluginConfigurationError` on any violation;
    empty-string env values are treated as unset; error messages never echo
    values.

- [ ] **Step 1: Write failing tests**

Create `test/config.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_SLUG,
  PRODUCTION_GATEWAY_BASE_URL,
  resolveConfig,
} from "../src/config.js";
import { PluginConfigurationError } from "../src/errors.js";

const baseEnv = {
  CLOUDFLARE_ACCOUNT_ID: "acct",
  CLOUDFLARE_GATEWAY_ID: "gw",
};

describe("required identifiers", () => {
  it("throws when CLOUDFLARE_ACCOUNT_ID is missing", () => {
    expect(() =>
      resolveConfig({ CLOUDFLARE_GATEWAY_ID: "gw" }),
    ).toThrow(PluginConfigurationError);
  });

  it("throws when CLOUDFLARE_GATEWAY_ID is missing", () => {
    expect(() =>
      resolveConfig({ CLOUDFLARE_ACCOUNT_ID: "acct" }),
    ).toThrow(PluginConfigurationError);
  });

  it("treats empty-string env values as unset", () => {
    expect(() =>
      resolveConfig({ ...baseEnv, CLOUDFLARE_ACCOUNT_ID: "" }),
    ).toThrow(PluginConfigurationError);
  });
});

describe("gateway token resolution", () => {
  it("prefers CLOUDFLARE_API_TOKEN over CF_AIG_TOKEN and apiKey", () => {
    const config = resolveConfig({
      ...baseEnv,
      CLOUDFLARE_API_TOKEN: "from-api-token-env",
      CF_AIG_TOKEN: "from-cf-aig-env",
    }, { apiKey: "from-option" });
    expect(config.gatewayToken).toBe("from-api-token-env");
  });

  it("falls back to CF_AIG_TOKEN", () => {
    const config = resolveConfig({
      ...baseEnv,
      CF_AIG_TOKEN: "from-cf-aig-env",
    }, { apiKey: "from-option" });
    expect(config.gatewayToken).toBe("from-cf-aig-env");
  });

  it("falls back to the apiKey plugin setting", () => {
    const config = resolveConfig(baseEnv, { apiKey: "from-option" });
    expect(config.gatewayToken).toBe("from-option");
  });

  it("throws when no gateway token source exists", () => {
    expect(() => resolveConfig(baseEnv)).toThrow(PluginConfigurationError);
  });

  it("rejects a non-string apiKey option", () => {
    expect(() =>
      resolveConfig(baseEnv, { apiKey: 42 }),
    ).toThrow(PluginConfigurationError);
  });
});

describe("relay token resolution", () => {
  it("prefers the environment variable over the plugin setting", () => {
    const config = resolveConfig(baseEnv, {
      relayToken: "from-option",
      apiKey: "gw-token",
    });
    expect(config.relayToken).toBe("from-option");
  });

  it("uses CLOUDFLARE_CHATGPT_RELAY_TOKEN first", () => {
    const config = resolveConfig({
      ...baseEnv,
      CLOUDFLARE_CHATGPT_RELAY_TOKEN: "from-env",
    }, { relayToken: "from-option", apiKey: "gw-token" });
    expect(config.relayToken).toBe("from-env");
  });

  it("throws when neither source exists", () => {
    expect(() =>
      resolveConfig(baseEnv, { apiKey: "gw-token" }),
    ).toThrow(PluginConfigurationError);
  });
});

describe("provider slug resolution", () => {
  it("defaults to chatgpt-codex-deno", () => {
    const config = resolveConfig(baseEnv, { apiKey: "gw", relayToken: "relay" });
    expect(config.providerSlug).toBe(DEFAULT_PROVIDER_SLUG);
    expect(DEFAULT_PROVIDER_SLUG).toBe("chatgpt-codex-deno");
  });

  it("prefers the environment variable, then the plugin setting", () => {
    const fromOption = resolveConfig(baseEnv, {
      providerSlug: "custom-slug",
      apiKey: "gw",
      relayToken: "relay",
    });
    expect(fromOption.providerSlug).toBe("custom-slug");

    const fromEnv = resolveConfig({
      ...baseEnv,
      CLOUDFLARE_CHATGPT_PROVIDER_SLUG: "env-slug",
    }, { providerSlug: "custom-slug", apiKey: "gw", relayToken: "relay" });
    expect(fromEnv.providerSlug).toBe("env-slug");
  });
});

describe("collectLogPayload resolution", () => {
  const full = (extra: Record<string, string>) =>
    resolveConfig({ ...baseEnv, ...extra }, {
      apiKey: "gw",
      relayToken: "relay",
    });

  it("accepts exact lowercase true and false from the environment", () => {
    expect(full({ CLOUDFLARE_AIG_COLLECT_LOG_PAYLOAD: "true" }).collectLogPayload).toBe(true);
    expect(full({ CLOUDFLARE_AIG_COLLECT_LOG_PAYLOAD: "false" }).collectLogPayload).toBe(false);
  });

  it("rejects invalid environment values without echoing them", () => {
    try {
      full({ CLOUDFLARE_AIG_COLLECT_LOG_PAYLOAD: "TRUE" });
      throw new Error("expected PluginConfigurationError");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginConfigurationError);
      expect((error as Error).message).not.toContain("TRUE");
    }
  });

  it("falls through to the boolean option and rejects non-booleans", () => {
    const config = resolveConfig(baseEnv, {
      collectLogPayload: false,
      apiKey: "gw",
      relayToken: "relay",
    });
    expect(config.collectLogPayload).toBe(false);

    expect(() =>
      resolveConfig(baseEnv, {
        collectLogPayload: "false",
        apiKey: "gw",
        relayToken: "relay",
      }),
    ).toThrow(PluginConfigurationError);
  });

  it("defaults to true when unset everywhere", () => {
    expect(full({}).collectLogPayload).toBe(true);
  });
});

describe("gateway base URL resolution", () => {
  const full = (extra: Record<string, string>) =>
    resolveConfig({ ...baseEnv, ...extra }, {
      apiKey: "gw",
      relayToken: "relay",
    });

  it("uses the production origin by default", () => {
    expect(full({}).gatewayBaseUrl).toBe(PRODUCTION_GATEWAY_BASE_URL);
    expect(PRODUCTION_GATEWAY_BASE_URL).toBe("https://gateway.ai.cloudflare.com");
  });

  it("accepts the override only in allowlisted test mode", () => {
    const config = full({
      CLOUDFLARE_AIG_TEST_MODE: "true",
      CLOUDFLARE_AIG_BASE_URL: "https://gateway.test.invalid",
    });
    expect(config.gatewayBaseUrl).toBe("https://gateway.test.invalid");
  });

  it("rejects overrides outside test mode or off the allowlist", () => {
    expect(() =>
      full({ CLOUDFLARE_AIG_BASE_URL: "https://gateway.test.invalid" }),
    ).toThrow(PluginConfigurationError);
    expect(() =>
      full({
        CLOUDFLARE_AIG_TEST_MODE: "true",
        CLOUDFLARE_AIG_BASE_URL: "https://evil.example",
      }),
    ).toThrow(PluginConfigurationError);
    expect(() =>
      full({
        CLOUDFLARE_AIG_TEST_MODE: "true",
        CLOUDFLARE_AIG_BASE_URL: "http://gateway.test.invalid",
      }),
    ).toThrow(PluginConfigurationError);
    expect(() =>
      full({
        CLOUDFLARE_AIG_TEST_MODE: "true",
        CLOUDFLARE_AIG_BASE_URL: "not-a-url",
      }),
    ).toThrow(PluginConfigurationError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `../src/config.js` not found.

- [ ] **Step 3: Implement `src/config.ts`**

```typescript
import { PluginConfigurationError } from "./errors.js";

export type EnvSource = Readonly<Record<string, string | undefined>>;

export type PluginOptions = {
  readonly apiKey?: unknown;
  readonly relayToken?: unknown;
  readonly providerSlug?: unknown;
  readonly collectLogPayload?: unknown;
};

export type ResolvedConfig = {
  readonly accountId: string;
  readonly gatewayId: string;
  readonly gatewayToken: string;
  readonly relayToken: string;
  readonly providerSlug: string;
  readonly collectLogPayload: boolean;
  readonly gatewayBaseUrl: string;
};

export const DEFAULT_PROVIDER_SLUG = "chatgpt-codex-deno";
export const PRODUCTION_GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com";

const TEST_GATEWAY_BASE_ORIGIN = "https://gateway.test.invalid";

function envValue(env: EnvSource, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

function requireEnv(env: EnvSource, name: string): string {
  const value = envValue(env, name);
  if (value === undefined) {
    throw new PluginConfigurationError(
      `cloudflare-ai-gateway-chatgpt: ${name} is required.`,
    );
  }
  return value;
}

function requireSecret(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PluginConfigurationError(
      `cloudflare-ai-gateway-chatgpt: ${label} is missing or invalid.`,
    );
  }
  return value;
}

function resolveCollectLogPayload(
  env: EnvSource,
  options: PluginOptions,
): boolean {
  const raw = envValue(env, "CLOUDFLARE_AIG_COLLECT_LOG_PAYLOAD");
  if (raw !== undefined) {
    if (raw === "true") {
      return true;
    }
    if (raw === "false") {
      return false;
    }
    throw new PluginConfigurationError(
      'cloudflare-ai-gateway-chatgpt: CLOUDFLARE_AIG_COLLECT_LOG_PAYLOAD' +
        ' must be exactly "true" or "false".',
    );
  }
  if (options.collectLogPayload !== undefined) {
    if (typeof options.collectLogPayload === "boolean") {
      return options.collectLogPayload;
    }
    throw new PluginConfigurationError(
      "cloudflare-ai-gateway-chatgpt: plugin setting collectLogPayload" +
        " must be a boolean.",
    );
  }
  return true;
}

function resolveGatewayBaseUrl(env: EnvSource): string {
  const override = envValue(env, "CLOUDFLARE_AIG_BASE_URL");
  if (override === undefined) {
    return PRODUCTION_GATEWAY_BASE_URL;
  }
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new PluginConfigurationError(
      "cloudflare-ai-gateway-chatgpt: CLOUDFLARE_AIG_BASE_URL is not a valid URL.",
    );
  }
  const testMode = envValue(env, "CLOUDFLARE_AIG_TEST_MODE") === "true";
  if (testMode && parsed.origin === TEST_GATEWAY_BASE_ORIGIN) {
    return parsed.origin;
  }
  throw new PluginConfigurationError(
    "cloudflare-ai-gateway-chatgpt: CLOUDFLARE_AIG_BASE_URL override" +
      " requires CLOUDFLARE_AIG_TEST_MODE=true and the allowlisted test" +
      " origin.",
  );
}

export function resolveConfig(
  env: EnvSource,
  options: PluginOptions = {},
): ResolvedConfig {
  const gatewayToken =
    envValue(env, "CLOUDFLARE_API_TOKEN") ??
    envValue(env, "CF_AIG_TOKEN") ??
    requireSecret(options.apiKey, "Gateway token (plugin setting apiKey)");
  const relayToken =
    envValue(env, "CLOUDFLARE_CHATGPT_RELAY_TOKEN") ??
    requireSecret(options.relayToken, "Relay token (plugin setting relayToken)");
  const optionSlug = options.providerSlug;
  const providerSlug =
    envValue(env, "CLOUDFLARE_CHATGPT_PROVIDER_SLUG") ??
    (typeof optionSlug === "string" && optionSlug.length > 0
      ? optionSlug
      : DEFAULT_PROVIDER_SLUG);

  return {
    accountId: requireEnv(env, "CLOUDFLARE_ACCOUNT_ID"),
    gatewayId: requireEnv(env, "CLOUDFLARE_GATEWAY_ID"),
    gatewayToken,
    relayToken,
    providerSlug,
    collectLogPayload: resolveCollectLogPayload(env, options),
    gatewayBaseUrl: resolveGatewayBaseUrl(env),
  };
}
```

- [ ] **Step 4: Add exports to `src/index.ts`**

```typescript
export {
  DEFAULT_PROVIDER_SLUG,
  PRODUCTION_GATEWAY_BASE_URL,
  resolveConfig,
} from "./config.js";
export type {
  EnvSource,
  PluginOptions,
  ResolvedConfig,
} from "./config.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all suites.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode-plugin/
git commit -m "feat: 設定解決モジュールを追加"
```

### Task 8: Gateway URL builder and Codex request matcher

**Files:**

- Create: `packages/opencode-plugin/src/gateway-url.ts`
- Create: `packages/opencode-plugin/src/matcher.ts`
- Modify: `packages/opencode-plugin/src/index.ts`
- Test: `packages/opencode-plugin/test/gateway-url.test.ts`
- Test: `packages/opencode-plugin/test/matcher.test.ts`

**Interfaces:**

- Consumes: `ResolvedConfig` from Task 7.
- Produces:
  - `function buildGatewayUrl(config: ResolvedConfig): string` —
    `{origin}/v1/{accountId}/{gatewayId}/custom-{providerSlug}/v1/responses`
    with URI-encoded segments.
  - `const CHATGPT_CODEX_ORIGIN = "https://chatgpt.com"`, `const
    CHATGPT_CODEX_PATHNAME = "/backend-api/codex/responses"`.
  - `function isChatgptCodexResponsesRequest(method: string, url: string):
    boolean` — true only for POST + https + `chatgpt.com` + exact pathname +
    empty query.

- [ ] **Step 1: Write failing tests**

Create `test/gateway-url.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildGatewayUrl } from "../src/gateway-url.js";
import type { ResolvedConfig } from "../src/config.js";

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    accountId: "acct",
    gatewayId: "gw",
    gatewayToken: "token",
    relayToken: "relay",
    providerSlug: "chatgpt-codex-deno",
    collectLogPayload: true,
    gatewayBaseUrl: "https://gateway.ai.cloudflare.com",
    ...overrides,
  };
}

describe("buildGatewayUrl", () => {
  it("maps to the Custom Provider path including /v1/responses", () => {
    expect(buildGatewayUrl(config())).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/custom-chatgpt-codex-deno/v1/responses",
    );
  });

  it("honors a test-mode base URL override", () => {
    expect(
      buildGatewayUrl(
        config({ gatewayBaseUrl: "https://gateway.test.invalid" }),
      ),
    ).toBe(
      "https://gateway.test.invalid/v1/acct/gw/custom-chatgpt-codex-deno/v1/responses",
    );
  });

  it("URI-encodes path segments", () => {
    expect(
      buildGatewayUrl(config({ accountId: "a b", providerSlug: "sl/ug" })),
    ).toBe(
      "https://gateway.ai.cloudflare.com/v1/a%20b/gw/custom-sl%2Fug/v1/responses",
    );
  });
});
```

Create `test/matcher.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { isChatgptCodexResponsesRequest } from "../src/matcher.js";

describe("isChatgptCodexResponsesRequest", () => {
  it("matches only the exact endpoint with POST", () => {
    expect(
      isChatgptCodexResponsesRequest("POST", "https://chatgpt.com/backend-api/codex/responses"),
    ).toBe(true);
  });

  it("rejects other methods, hosts, schemes, paths, and queries", () => {
    expect(
      isChatgptCodexResponsesRequest("GET", "https://chatgpt.com/backend-api/codex/responses"),
    ).toBe(false);
    expect(
      isChatgptCodexResponsesRequest("POST", "http://chatgpt.com/backend-api/codex/responses"),
    ).toBe(false);
    expect(
      isChatgptCodexResponsesRequest("POST", "https://api.openai.com/v1/responses"),
    ).toBe(false);
    expect(
      isChatgptCodexResponsesRequest("POST", "https://auth.openai.com/oauth/token"),
    ).toBe(false);
    expect(
      isChatgptCodexResponsesRequest("POST", "https://chatgpt.com/backend-api/other"),
    ).toBe(false);
    expect(
      isChatgptCodexResponsesRequest(
        "POST",
        "https://chatgpt.com/backend-api/codex/responses?trace=1",
      ),
    ).toBe(false);
    expect(isChatgptCodexResponsesRequest("POST", "not a url")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/gateway-url.ts`**

```typescript
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
```

- [ ] **Step 4: Implement `src/matcher.ts`**

```typescript
export const CHATGPT_CODEX_ORIGIN = "https://chatgpt.com";
export const CHATGPT_CODEX_PATHNAME = "/backend-api/codex/responses";

export function isChatgptCodexResponsesRequest(
  method: string,
  url: string,
): boolean {
  if (method.toUpperCase() !== "POST") {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.hostname === "chatgpt.com" &&
    parsed.pathname === CHATGPT_CODEX_PATHNAME &&
    parsed.search === ""
  );
}
```

- [ ] **Step 5: Add exports to `src/index.ts`**

```typescript
export { buildGatewayUrl } from "./gateway-url.js";
export {
  CHATGPT_CODEX_ORIGIN,
  CHATGPT_CODEX_PATHNAME,
  isChatgptCodexResponsesRequest,
} from "./matcher.js";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all suites.

- [ ] **Step 7: Commit**

```bash
git add packages/opencode-plugin/
git commit -m "feat: Gateway URL構築とCodexリクエスト判定を追加"
```

---

## PR #4 — feat/plugin-fetch-interposer

### Task 9: Request rewrite with control headers

**Files:**

- Create: `packages/opencode-plugin/src/request-rewrite.ts`
- Modify: `packages/opencode-plugin/src/index.ts`
- Test: `packages/opencode-plugin/test/request-rewrite.test.ts`

**Interfaces:**

- Consumes: `ResolvedConfig` (Task 7), `buildGatewayUrl` (Task 8).
- Produces:
  - `const METADATA_HEADER_VALUE =
    '{"source":"opencode","auth_type":"chatgpt_subscription","plugin":"cloudflare-ai-gateway-chatgpt"}'`.
  - `function applyControlHeaders(headers: Headers, config: ResolvedConfig):
    Headers` — sets the seven control headers (Global Constraints) and returns
    the same `Headers`.
  - `function rewriteCodexRequest(request: Request, config: ResolvedConfig):
    Request` — copies original headers, applies control headers, returns a new
    `Request` targeting the Gateway URL preserving method, body stream, and
    abort signal.

- [ ] **Step 1: Write failing tests**

Create `test/request-rewrite.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../src/config.js";
import {
  applyControlHeaders,
  METADATA_HEADER_VALUE,
  rewriteCodexRequest,
} from "../src/request-rewrite.js";

const config: ResolvedConfig = {
  accountId: "acct",
  gatewayId: "gw",
  gatewayToken: "sentinel-gw-token",
  relayToken: "sentinel-relay-token",
  providerSlug: "chatgpt-codex-deno",
  collectLogPayload: false,
  gatewayBaseUrl: "https://gateway.ai.cloudflare.com",
};

function codexRequest(): Request {
  return new Request("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers: {
      Authorization: "Bearer oauth-access-token",
      "ChatGPT-Account-Id": "account-42",
      "X-Codex-Residency": "us",
    },
    body: '{"model":"gpt-5.6-luna","store":false,"stream":true}',
  });
}

describe("applyControlHeaders", () => {
  it("sets every required control header with exact values", () => {
    const headers = applyControlHeaders(new Headers(), config);
    expect(headers.get("cf-aig-authorization")).toBe("Bearer sentinel-gw-token");
    expect(headers.get("x-chatgpt-relay-authorization")).toBe("Bearer sentinel-relay-token");
    expect(headers.get("cf-aig-collect-log")).toBe("true");
    expect(headers.get("cf-aig-collect-log-payload")).toBe("false");
    expect(headers.get("cf-aig-metadata")).toBe(METADATA_HEADER_VALUE);
    expect(headers.get("cf-aig-skip-cache")).toBe("true");
    expect(headers.get("cf-aig-max-attempts")).toBe("1");
    expect(METADATA_HEADER_VALUE).toBe(
      '{"source":"opencode","auth_type":"chatgpt_subscription","plugin":"cloudflare-ai-gateway-chatgpt"}',
    );
  });
});

describe("rewriteCodexRequest", () => {
  it("preserves OAuth, account, residency headers and body", async () => {
    const original = codexRequest();
    const rewritten = rewriteCodexRequest(original, config);

    expect(rewritten.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/custom-chatgpt-codex-deno/v1/responses",
    );
    expect(rewritten.method).toBe("POST");
    expect(rewritten.headers.get("Authorization")).toBe("Bearer oauth-access-token");
    expect(rewritten.headers.get("ChatGPT-Account-Id")).toBe("account-42");
    expect(rewritten.headers.get("X-Codex-Residency")).toBe("us");
    expect(await rewritten.text()).toBe(
      '{"model":"gpt-5.6-luna","store":false,"stream":true}',
    );
  });

  it("preserves the abort signal reference", () => {
    const controller = new AbortController();
    const original = new Request(
      "https://chatgpt.com/backend-api/codex/responses",
      {
        method: "POST",
        body: "x",
        signal: controller.signal,
      },
    );
    const rewritten = rewriteCodexRequest(original, config);
    expect(rewritten.signal).toBe(controller.signal);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/request-rewrite.ts`**

```typescript
import type { ResolvedConfig } from "./config.js";
import { buildGatewayUrl } from "./gateway-url.js";

export const METADATA_HEADER_VALUE = JSON.stringify({
  source: "opencode",
  auth_type: "chatgpt_subscription",
  plugin: "cloudflare-ai-gateway-chatgpt",
});

export function applyControlHeaders(
  headers: Headers,
  config: ResolvedConfig,
): Headers {
  headers.set("cf-aig-authorization", `Bearer ${config.gatewayToken}`);
  headers.set("x-chatgpt-relay-authorization", `Bearer ${config.relayToken}`);
  headers.set("cf-aig-collect-log", "true");
  headers.set(
    "cf-aig-collect-log-payload",
    config.collectLogPayload ? "true" : "false",
  );
  headers.set("cf-aig-metadata", METADATA_HEADER_VALUE);
  headers.set("cf-aig-skip-cache", "true");
  headers.set("cf-aig-max-attempts", "1");
  return headers;
}

export function rewriteCodexRequest(
  request: Request,
  config: ResolvedConfig,
): Request {
  const headers = applyControlHeaders(new Headers(request.headers), config);
  return new Request(buildGatewayUrl(config), {
    method: request.method,
    headers,
    body: request.body,
    signal: request.signal,
    ...(request.body ? ({ duplex: "half" } as RequestInit) : {}),
  });
}
```

- [ ] **Step 4: Add exports to `src/index.ts`**

```typescript
export {
  applyControlHeaders,
  METADATA_HEADER_VALUE,
  rewriteCodexRequest,
} from "./request-rewrite.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all suites.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode-plugin/
git commit -m "feat: Codexリクエスト書き換えを追加"
```

### Task 10: Fetch interposer

**Files:**

- Create: `packages/opencode-plugin/src/interposer.ts`
- Modify: `packages/opencode-plugin/src/index.ts`
- Test: `packages/opencode-plugin/test/interposer.test.ts`

**Interfaces:**

- Consumes: `isChatgptCodexResponsesRequest` (Task 8), `rewriteCodexRequest`
  (Task 9), `ResolvedConfig` (Task 7).
- Produces:
  - `type FetchLike = (input: RequestInfo | URL, init?: RequestInit) =>
    Promise<Response>`
  - `type ConfigResolver = () => ResolvedConfig`
  - `function installFetchInterposer(deps: { readonly resolveConfig:
    ConfigResolver; readonly target?: { fetch: FetchLike } }): void` — installs
    once per target; captures the fetch active at install time; non-matching
    traffic delegates untouched; matching traffic resolves config lazily
    (throwing fails the request) and forwards the rewritten `Request`; returns
    the original `Response` object unchanged.

- [ ] **Step 1: Write failing tests**

Create `test/interposer.test.ts`:

```typescript
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../src/config.js";
import { installFetchInterposer, type FetchLike } from "../src/interposer.js";
import { PluginConfigurationError } from "../src/errors.js";

type RecordedRequest = {
  url: string;
  method: string;
  headers: Headers;
  bodyText: string | null;
  signal: AbortSignal | null;
};

function createSpyFetch(responseStatus = 200): {
  fetch: FetchLike;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    const bodyText = request.body === null ? null : await request.text();
    requests.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      bodyText,
      signal: request.signal,
    });
    return new Response("ok", { status: responseStatus });
  };
  return { fetch, requests };
}

const config: ResolvedConfig = {
  accountId: "acct",
  gatewayId: "gw",
  gatewayToken: "sentinel-gw-token",
  relayToken: "sentinel-relay-token",
  providerSlug: "chatgpt-codex-deno",
  collectLogPayload: true,
  gatewayBaseUrl: "https://gateway.ai.cloudflare.com",
};

const gatewayUrl = "https://gateway.ai.cloudflare.com/v1/acct/gw/custom-chatgpt-codex-deno/v1/responses";
const codexUrl = "https://chatgpt.com/backend-api/codex/responses";

afterEach(() => {
  const scope = globalThis as typeof globalThis & {
    __cfAigChatgptInterposerInstalled?: boolean;
  };
  delete scope.__cfAigChatgptInterposerInstalled;
});

describe("installFetchInterposer", () => {
  it("passes non-matching traffic through untouched", async () => {
    const spy = createSpyFetch();
    const target: { fetch: FetchLike } = { fetch: spy.fetch };
    installFetchInterposer({ resolveConfig: () => config, target });

    await target.fetch("https://auth.openai.com/oauth/token", { method: "POST" });
    await target.fetch("https://api.openai.com/v1/models");
    await target.fetch("https://chatgpt.com/backend-api/other", {
      method: "POST",
    });
    await target.fetch(`${codexUrl}?trace=1`, { method: "POST" });
    await target.fetch(codexUrl, { method: "GET" });

    expect(spy.requests).toHaveLength(5);
    for (const request of spy.requests) {
      expect(request.headers.get("cf-aig-authorization")).toBeNull();
      expect(request.headers.get("x-chatgpt-relay-authorization")).toBeNull();
    }
  });

  it("rewrites a matching request given string input and init", async () => {
    const spy = createSpyFetch();
    const target: { fetch: FetchLike } = { fetch: spy.fetch };
    installFetchInterposer({ resolveConfig: () => config, target });

    const controller = new AbortController();
    const response = await target.fetch(codexUrl, {
      method: "POST",
      headers: {
        Authorization: "Bearer oauth-access-token",
        "ChatGPT-Account-Id": "account-42",
      },
      body: '{"model":"gpt-5.6-luna","store":false,"stream":true}',
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(spy.requests).toHaveLength(1);
    const sent = spy.requests[0];
    expect(sent.url).toBe(gatewayUrl);
    expect(sent.method).toBe("POST");
    expect(sent.headers.get("Authorization")).toBe("Bearer oauth-access-token");
    expect(sent.headers.get("ChatGPT-Account-Id")).toBe("account-42");
    expect(sent.headers.get("cf-aig-authorization")).toBe("Bearer sentinel-gw-token");
    expect(sent.headers.get("x-chatgpt-relay-authorization")).toBe("Bearer sentinel-relay-token");
    expect(sent.headers.get("cf-aig-collect-log")).toBe("true");
    expect(sent.headers.get("cf-aig-collect-log-payload")).toBe("true");
    expect(sent.headers.get("cf-aig-metadata")).toBe(
      '{"source":"opencode","auth_type":"chatgpt_subscription","plugin":"cloudflare-ai-gateway-chatgpt"}',
    );
    expect(sent.headers.get("cf-aig-skip-cache")).toBe("true");
    expect(sent.headers.get("cf-aig-max-attempts")).toBe("1");
    expect(sent.bodyText).toBe('{"model":"gpt-5.6-luna","store":false,"stream":true}');
    expect(sent.signal).toBe(controller.signal);
  });

  it("rewrites Request input; returns response object as-is", async () => {
    const spy = createSpyFetch(201);
    const target: { fetch: FetchLike } = { fetch: spy.fetch };
    installFetchInterposer({ resolveConfig: () => config, target });

    const outbound = new Request(codexUrl, {
      method: "POST",
      headers: { Authorization: "Bearer oauth-access-token" },
      body: "payload",
    });
    const response = await target.fetch(outbound);

    expect(spy.requests[0].url).toBe(gatewayUrl);
    expect(spy.requests[0].bodyText).toBe("payload");
    expect(response.status).toBe(201);
  });

  it("fails closed when configuration resolution throws", async () => {
    const spy = createSpyFetch();
    const target: { fetch: FetchLike } = { fetch: spy.fetch };
    installFetchInterposer({
      resolveConfig: () => {
        throw new PluginConfigurationError("missing config");
      },
      target,
    });

    await expect(target.fetch(codexUrl, { method: "POST", body: "x" })).rejects.toThrow(
      PluginConfigurationError,
    );
    expect(spy.requests).toHaveLength(0);
  });

  it("delegates to the fetch function active at install time", async () => {
    const spy = createSpyFetch();
    const calls: string[] = [];
    const firstWrapper: FetchLike = (input, init) => {
      calls.push("first");
      return spy.fetch(input, init);
    };
    const target: { fetch: FetchLike } = { fetch: firstWrapper };
    installFetchInterposer({ resolveConfig: () => config, target });

    const previous = target.fetch;
    target.fetch = (input, init) => {
      calls.push("second");
      return previous(input, init);
    };

    await target.fetch(codexUrl, { method: "POST", body: "x" });

    expect(calls).toEqual(["second", "first"]);
  });

  it("installs at most once per target", async () => {
    const spy = createSpyFetch();
    const target: { fetch: FetchLike } = { fetch: spy.fetch };
    installFetchInterposer({ resolveConfig: () => config, target });
    const installed = target.fetch;
    installFetchInterposer({
      resolveConfig: () => {
        throw new Error("second install must be ignored");
      },
      target,
    });

    expect(target.fetch).toBe(installed);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/interposer.ts`**

```typescript
import type { ResolvedConfig } from "./config.js";
import { isChatgptCodexResponsesRequest } from "./matcher.js";
import { rewriteCodexRequest } from "./request-rewrite.js";

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ConfigResolver = () => ResolvedConfig;

type FlaggedTarget = {
  fetch: FetchLike;
  __cfAigChatgptInterposerInstalled?: boolean;
};

export function installFetchInterposer(deps: {
  readonly resolveConfig: ConfigResolver;
  readonly target?: { fetch: FetchLike };
}): void {
  const target = (deps.target ?? globalScope) as FlaggedTarget;
  if (target.__cfAigChatgptInterposerInstalled === true) {
    return;
  }

  const originalFetch = target.fetch.bind(target) as FetchLike;
  const intercepted: FetchLike = async (input, init) => {
    const method =
      init?.method ??
        (typeof Request !== "undefined" && input instanceof Request
          ? input.method
          : "GET");
    const url = input instanceof Request ? input.url : String(input);
    if (!isChatgptCodexResponsesRequest(method, url)) {
      return originalFetch(input, init);
    }
    const config = deps.resolveConfig();
    const request = new Request(input, init);
    return originalFetch(rewriteCodexRequest(request, config));
  };

  target.fetch = intercepted;
  target.__cfAigChatgptInterposerInstalled = true;
}
```

- [ ] **Step 4: Add exports to `src/index.ts`**

```typescript
export { installFetchInterposer } from "./interposer.js";
export type { ConfigResolver, FetchLike } from "./interposer.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all suites.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode-plugin/
git commit -m "feat: fetchインターポーザーを追加"
```

### Task 11: Plugin entry point

**Files:**

- Create: `packages/opencode-plugin/src/plugin.ts`
- Modify: `packages/opencode-plugin/src/index.ts`
- Test: `packages/opencode-plugin/test/plugin.test.ts`

**Interfaces:**

- Consumes: `assertSupportedHost`/`resolveHostVersionCapability` (Task 6),
  `installFetchInterposer` (Task 10), `resolveConfig`/`PluginOptions` (Task 7).
- Produces: `const CloudflareAiGatewayChatgpt: Plugin` — compatible with
  `@opencode-ai/plugin`'s `Plugin` type `(input, options?) => Promise<Hooks>`.
  Rejects activation (throws `UnsupportedOpenCodeVersionError`) before
  installing anything when the capability is absent/out-of-range; installs the
  interposer reading `process.env` lazily; returns `{}` hooks.

- [ ] **Step 1: Write failing tests**

Create `test/plugin.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareAiGatewayChatgpt } from "../src/plugin.js";
import { UnsupportedOpenCodeVersionError } from "../src/errors.js";

const originalFetch = globalThis.fetch;

function resetInterposerState(): void {
  globalThis.fetch = originalFetch;
  const scope = globalThis as typeof globalThis & {
    __cfAigChatgptInterposerInstalled?: boolean;
  };
  delete scope.__cfAigChatgptInterposerInstalled;
}

afterEach(() => {
  resetInterposerState();
  vi.unstubAllEnvs();
});

describe("CloudflareAiGatewayChatgpt", () => {
  it("rejects activation when the capability is absent", async () => {
    await expect(CloudflareAiGatewayChatgpt({} as never)).rejects.toThrow(
      UnsupportedOpenCodeVersionError,
    );
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("rejects activation for unsupported versions", async () => {
    await expect(
      CloudflareAiGatewayChatgpt({ opencode: { version: "1.18.19" } } as never),
    ).rejects.toThrow(UnsupportedOpenCodeVersionError);
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("installs the interposer when the host version is supported", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
    vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "gw");
    vi.stubEnv("CLOUDFLARE_CHATGPT_RELAY_TOKEN", "sentinel-relay-token");

    const hooks = await CloudflareAiGatewayChatgpt(
      { opencode: { version: "1.19.0" } } as never,
      { apiKey: "sentinel-gw-token" },
    );

    expect(hooks).toEqual({});
    expect(globalThis.fetch).not.toBe(originalFetch);
  });

  it("fails closed with a configuration error", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct");
    vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "gw");
    vi.stubEnv("CLOUDFLARE_CHATGPT_RELAY_TOKEN", "sentinel-relay-token");

    await CloudflareAiGatewayChatgpt(
      { opencode: { version: "1.19.0" } } as never,
      {},
    );

    await expect(
      globalThis.fetch("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST",
        body: "x",
      }),
    ).rejects.toThrow(/apiKey/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `../src/plugin.js` not found.

- [ ] **Step 3: Implement `src/plugin.ts`**

```typescript
import type { Plugin } from "@opencode-ai/plugin";
import { resolveConfig, type PluginOptions } from "./config.js";
import { assertSupportedHost, resolveHostVersionCapability } from "./host-version.js";
import { installFetchInterposer } from "./interposer.js";

export const CloudflareAiGatewayChatgpt: Plugin = async (input, options) => {
  assertSupportedHost(resolveHostVersionCapability(input));
  installFetchInterposer({
    resolveConfig: () => resolveConfig(process.env, (options ?? {}) as PluginOptions),
  });
  return {};
};
```

- [ ] **Step 4: Finalize `src/index.ts`**

Ensure `src/index.ts` contains, in addition to previous exports:

```typescript
export { CloudflareAiGatewayChatgpt } from "./plugin.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all suites.

- [ ] **Step 6: Verify typecheck and commit**

```bash
npm run typecheck && npm test
git add packages/opencode-plugin/
git commit -m "feat: プラグインエントリポイントを追加"
```

---

## PR #5 — test/byok-load-order-contract

### Task 12: BYOK load-order contract tests and diagnostics redaction

**Files:**

- Create: `packages/opencode-plugin/test/byok-contract.test.ts`
- Create: `packages/opencode-plugin/test/redaction.test.ts`
- Create: `packages/opencode-plugin/test/package-consistency.test.ts`

**Interfaces:**

- Consumes: `installFetchInterposer` with injected `target` (Task 10),
  `resolveConfig` (Task 7), `SUPPORTED_OPENCODE_RANGE` (Task 6).
- Produces: contract guarantees — composing a corrected-BYOK-style interposer
  with this plugin in **either load order** yields the same final request:
  Gateway URL `.../custom-chatgpt-codex-deno/v1/responses` with OAuth
  `Authorization` preserved and control headers present. Plus redaction
  assertions and a peerDependencies/range consistency check.

- [ ] **Step 1: Write the BYOK contract tests**

Create `test/byok-contract.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../src/config.js";
import { installFetchInterposer, type FetchLike } from "../src/interposer.js";

const config: ResolvedConfig = {
  accountId: "acct",
  gatewayId: "gw",
  gatewayToken: "sentinel-gw-token",
  relayToken: "sentinel-relay-token",
  providerSlug: "chatgpt-codex-deno",
  collectLogPayload: true,
  gatewayBaseUrl: "https://gateway.ai.cloudflare.com",
};

const gatewayUrl = "https://gateway.ai.cloudflare.com/v1/acct/gw/custom-chatgpt-codex-deno/v1/responses";
const codexUrl = "https://chatgpt.com/backend-api/codex/responses";

type RecordedRequest = { url: string; headers: Headers };

function createSpy(): { fetch: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, headers: request.headers });
    return new Response("ok");
  };
  return { fetch, requests };
}

function createCorrectedByokInterposer(inner: FetchLike): FetchLike {
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://api.openai.com/")) {
      return inner(input, init);
    }
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    return inner(
      "https://gateway.ai.cloudflare.com/v1/byok-acct/byok-gw/openai",
      { ...init, headers },
    );
  };
}

describe("BYOK compatibility contract", () => {
  it("preserves OAuth Authorization when BYOK loads first", async () => {
    const spy = createSpy();
    const target: { fetch: FetchLike } = { fetch: spy.fetch };
    target.fetch = createCorrectedByokInterposer(target.fetch);
    installFetchInterposer({ resolveConfig: () => config, target });

    await target.fetch(codexUrl, {
      method: "POST",
      headers: {
        Authorization: "Bearer oauth-access-token",
        "ChatGPT-Account-Id": "account-42",
      },
      body: '{"model":"gpt-5.6-luna"}',
    });

    expect(spy.requests).toHaveLength(1);
    const sent = spy.requests[0];
    expect(sent.url).toBe(gatewayUrl);
    expect(sent.headers.get("Authorization")).toBe("Bearer oauth-access-token");
    expect(sent.headers.get("ChatGPT-Account-Id")).toBe("account-42");
    expect(sent.headers.get("cf-aig-authorization")).toBe("Bearer sentinel-gw-token");
    expect(sent.headers.get("x-chatgpt-relay-authorization")).toBe("Bearer sentinel-relay-token");
  });

  it("preserves OAuth Authorization when the plugin loads first", async () => {
    const spy = createSpy();
    const target: { fetch: FetchLike } = { fetch: spy.fetch };
    installFetchInterposer({ resolveConfig: () => config, target });
    target.fetch = createCorrectedByokInterposer(target.fetch);

    await target.fetch(codexUrl, {
      method: "POST",
      headers: {
        Authorization: "Bearer oauth-access-token",
        "ChatGPT-Account-Id": "account-42",
      },
      body: '{"model":"gpt-5.6-luna"}',
    });

    expect(spy.requests).toHaveLength(1);
    const sent = spy.requests[0];
    expect(sent.url).toBe(gatewayUrl);
    expect(sent.headers.get("Authorization")).toBe("Bearer oauth-access-token");
    expect(sent.headers.get("cf-aig-authorization")).toBe("Bearer sentinel-gw-token");
  });

  it("leaves api.openai.com handling to BYOK in both orders", async () => {
    const spy = createSpy();
    const targetA: { fetch: FetchLike } = { fetch: spy.fetch };
    targetA.fetch = createCorrectedByokInterposer(targetA.fetch);
    installFetchInterposer({ resolveConfig: () => config, target: targetA });
    await targetA.fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sk-byok" },
      body: "{}",
    });
    expect(spy.requests[0].url).toBe(
      "https://gateway.ai.cloudflare.com/v1/byok-acct/byok-gw/openai",
    );
    expect(spy.requests[0].headers.get("Authorization")).toBeNull();

    const spyB = createSpy();
    const targetB: { fetch: FetchLike } = { fetch: spyB.fetch };
    installFetchInterposer({ resolveConfig: () => config, target: targetB });
    targetB.fetch = createCorrectedByokInterposer(targetB.fetch);
    await targetB.fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sk-byok" },
      body: "{}",
    });
    expect(spyB.requests[0].url).toBe(
      "https://gateway.ai.cloudflare.com/v1/byok-acct/byok-gw/openai",
    );
    expect(spyB.requests[0].headers.get("Authorization")).toBeNull();
  });
});
```

- [ ] **Step 2: Write the redaction tests**

Create `test/redaction.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { PluginConfigurationError } from "../src/errors.js";

const sentinelGateway = "sentinel-gw-do-not-leak";
const sentinelRelay = "sentinel-relay-do-not-leak";

function expectNoCredentials(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  expect(message).not.toContain(sentinelGateway);
  expect(message).not.toContain(sentinelRelay);
}

describe("diagnostics redaction", () => {
  it("never includes credentials in configuration errors", () => {
    try {
      resolveConfig(
        {
          CLOUDFLARE_ACCOUNT_ID: "acct",
          CLOUDFLARE_GATEWAY_ID: "gw",
          CLOUDFLARE_API_TOKEN: sentinelGateway,
        },
        {},
      );
      throw new Error("expected PluginConfigurationError");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginConfigurationError);
      expectNoCredentials(error);
    }

    try {
      resolveConfig(
        {
          CLOUDFLARE_ACCOUNT_ID: "acct",
          CLOUDFLARE_GATEWAY_ID: "gw",
          CLOUDFLARE_CHATGPT_RELAY_TOKEN: sentinelRelay,
        },
        {},
      );
      throw new Error("expected PluginConfigurationError");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginConfigurationError);
      expectNoCredentials(error);
    }
  });

  it("never includes credentials in invalid collect-log-payload errors", () => {
    try {
      resolveConfig(
        {
          CLOUDFLARE_ACCOUNT_ID: "acct",
          CLOUDFLARE_GATEWAY_ID: "gw",
          CLOUDFLARE_API_TOKEN: sentinelGateway,
          CLOUDFLARE_CHATGPT_RELAY_TOKEN: sentinelRelay,
          CLOUDFLARE_AIG_COLLECT_LOG_PAYLOAD: "yes",
        },
        {},
      );
      throw new Error("expected PluginConfigurationError");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginConfigurationError);
      expectNoCredentials(error);
    }
  });
});
```

- [ ] **Step 3: Write the package consistency test**

Create `test/package-consistency.test.ts`:

```typescript
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SUPPORTED_OPENCODE_RANGE } from "../src/host-version.js";

describe("package metadata consistency", () => {
  it("keeps peerDependencies.opencode in sync with the range", async () => {
    const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const pkg = JSON.parse(raw) as { peerDependencies: { opencode: string } };
    expect(pkg.peerDependencies.opencode).toBe(SUPPORTED_OPENCODE_RANGE);
    expect(SUPPORTED_OPENCODE_RANGE).toBe(">=1.19.0 <2");
  });
});
```

- [ ] **Step 4: Run everything**

Run: `npm run typecheck && npm test`
Expected: PASS — all suites.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode-plugin/
git commit -m "test: BYOK両ロード順コントラクトと診断の秘匿テストを追加"
```

---

## PR #6 — chore/ci-and-docs

### Task 13: CI workflows and protected acceptance scaffold

**Files:**

- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/acceptance.yml`
- Create: `apps/deno-relay/acceptance_test.ts`

**Interfaces:**

- Consumes: workspace layout (Task 1), plugin scripts (Task 5).
- Produces: CI running `deno fmt --check`, `deno lint`, `deno test` (relay) and
  `npm ci`, `npm run typecheck`, `npm test` (plugin) on every push/PR; a
  manually dispatched protected acceptance job gated on secrets.

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push:
    branches: [master]
  pull_request:

jobs:
  relay:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - run: deno fmt --check
      - run: deno lint
      - run: deno test

  plugin:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: packages/opencode-plugin
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: packages/opencode-plugin/package-lock.json
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 2: Create `apps/deno-relay/acceptance_test.ts`**

```typescript
const origin = Deno.env.get("RELAY_ACCEPTANCE_ORIGIN");

Deno.test({
  name: "acceptance: relay rejects wrong method with 404",
  ignore: origin === undefined,
  fn: async () => {
    const response = await fetch(`${origin}/v1/responses`, { method: "GET" });
    if (response.status !== 404) {
      throw new Error(`expected 404, received ${response.status}`);
    }
  },
});

Deno.test({
  name: "acceptance: relay rejects missing credentials with 401",
  ignore: origin === undefined,
  fn: async () => {
    const response = await fetch(`${origin}/v1/responses`, { method: "POST" });
    if (response.status !== 401) {
      throw new Error(`expected 401, received ${response.status}`);
    }
  },
});
```

- [ ] **Step 3: Create `.github/workflows/acceptance.yml`**

```yaml
name: Protected acceptance
on:
  workflow_dispatch:

jobs:
  acceptance:
    runs-on: ubuntu-latest
    environment: protected-acceptance
    env:
      RELAY_ACCEPTANCE_ORIGIN: ${{ vars.RELAY_ACCEPTANCE_ORIGIN }}
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - name: Skip when no acceptance origin is configured
        if: ${{ vars.RELAY_ACCEPTANCE_ORIGIN == '' }}
        run: |
          echo "RELAY_ACCEPTANCE_ORIGIN is not configured; skipping."
          exit 0
      - run: deno test --allow-net --allow-env apps/deno-relay/acceptance_test.ts
```

- [ ] **Step 4: Verify locally**

Run: `deno test && deno fmt --check && deno lint`
Expected: PASS — acceptance tests are skipped locally (`ignore: true`) because
`RELAY_ACCEPTANCE_ORIGIN` is unset.

- [ ] **Step 5: Commit**

```bash
git add .github/ apps/deno-relay/acceptance_test.ts
git commit -m "ci: CIと保護付き受け入れワークフローを追加"
```

### Task 14: READMEs and release checklist

**Files:**

- Modify: `README.md` (replace skeleton from Task 2)
- Create: `packages/opencode-plugin/README.md`

**Interfaces:**

- Consumes: all prior tasks' public interfaces.
- Produces: operator-facing documentation; release checklist recording the
  blocked-on-capability status.

- [ ] **Step 1: Replace root `README.md`**

````markdown
# opencode-cloudflare-ai-gateway-chatgpt

OpenCode の ChatGPT Codex 通信を Cloudflare AI Gateway 経由で観測可能にするリポジトリ。

## 構成

- `packages/opencode-plugin`: npm パッケージ `@yohi/cloudflare-ai-gateway-chatgpt`
- `apps/deno-relay`: Deno Deploy 固定アップストリーム egress relay

## 経路

```text
OpenCode built-in ChatGPT OAuth
  -> plugin fetch interposer
  -> Cloudflare AI Gateway Custom Provider
  -> Deno Deploy relay
  -> https://chatgpt.com/backend-api/codex/responses
```

## プラグイン設定

- Account ID: 環境変数 `CLOUDFLARE_ACCOUNT_ID`(必須)
- Gateway ID: 環境変数 `CLOUDFLARE_GATEWAY_ID`(必須)
- Gateway token: `CLOUDFLARE_API_TOKEN` → `CF_AIG_TOKEN` →
  プラグイン `apiKey`
- Relay token: `CLOUDFLARE_CHATGPT_RELAY_TOKEN` →
  プラグイン `relayToken`
- Provider slug: `CLOUDFLARE_CHATGPT_PROVIDER_SLUG` →
  プラグイン `providerSlug` → 既定 `chatgpt-codex-deno`
- ログペイロード収集:
  `CLOUDFLARE_AIG_COLLECT_LOG_PAYLOAD`(`true` / `false` のみ) →
  プラグイン `collectLogPayload`(boolean) → 既定 `true`
- Gateway base URL: 本番 `https://gateway.ai.cloudflare.com`。
  `CLOUDFLARE_AIG_TEST_MODE=true` かつ `https://gateway.test.invalid`
  の場合のみ `CLOUDFLARE_AIG_BASE_URL` で上書き可

プラグイン設定は `opencode.json` の `plugin` 配列でオブジェクト形式(`["パッケージ名", { オプション }]`)で渡す。

## パスマッピング

Custom Provider の `base_url` には relay オリジンのみを指定する
(`/v1` を含めない)。Gateway URL は
`{base}/v1/{account}/{gateway}/custom-{slug}/v1/responses` となり、
relay の `POST /v1/responses` に対応する。

## サポート対象バージョンとフェイルクローズ

- サポート範囲は `packages/opencode-plugin/package.json` の
  `peerDependencies.opencode`(現行 `>=1.19.0 <2`)が正とする。
- OpenCode がホストバージョン能力を公開していない場合、プラグインは
  アクティベートを拒否し、インターポーザーは導入されない。
  該当 Codex リクエストはフェイルクローズし、直接 ChatGPT へ迂回する
  ことはない。
- リリースは OpenCode 側のホストバージョン能力の提供を前提とする(下記チェックリスト)。

## BYOK 互換性

`@yohi/cloudflare-ai-gateway-byok` の互換リリース以降と組み合わせて使用すること。BYOK が自ら生成した
リクエスト以外の `Authorization` を削除しないことが契約である。本リポジトリのコントラクトテスト
(`packages/opencode-plugin/test/byok-contract.test.ts`)が両ロード順を検証する。

## 開発

```bash
deno test                              # relay テスト
deno lint && deno fmt --check          # relay lint/format
cd packages/opencode-plugin && npm ci  # plugin 依存
npm run typecheck && npm test          # plugin テスト
```

## リリースチェックリスト(npm 公開)

1. [ ] OpenCode が `PluginInput` でホストバージョン能力を公開したリリースが出ていること。
2. [ ] `SUPPORTED_OPENCODE_RANGE` と `peerDependencies.opencode` を
   実際の能力提供バージョンに更新し、
   `test/package-consistency.test.ts` を通すこと。
3. [ ] 保護付き受け入れスイート(実 Cloudflare / Deno Deploy /
   ChatGPT OAuth 認証情報)を `protected-acceptance` 環境で実行し、
   200 SSE・tool call・reasoning・token refresh・代表エラー・
   両ログペイロードモード・Gateway ログ作成・パスマッピングを
   確認すること。
4. [ ] README のサポート範囲表記を更新すること。
5. [ ] `npm publish`(初回は `npm publish --access public`)。

設計詳細は `docs/superpowers/specs/2026-08-20-chatgpt-ai-gateway-design.md` を参照。
````

- [ ] **Step 2: Create `packages/opencode-plugin/README.md`**

```markdown
# @yohi/cloudflare-ai-gateway-chatgpt

OpenCode plugin that routes ChatGPT Codex requests through Cloudflare AI Gateway
and a fixed-upstream Deno Deploy relay. Requests fail closed; they never bypass
the gateway.

See the repository root README for configuration, path mapping, supported
versions, and the release checklist.
```

- [ ] **Step 3: Verify markdown and full suites**

Run: `deno fmt --check && deno lint && deno test && cd packages/opencode-plugin
&& npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add README.md packages/opencode-plugin/README.md
git commit -m "docs: READMEとリリースチェックリストを整備"
```

---

## Self-Review

**1. Spec coverage:**

- Scope/two deliverables → Tasks 1–4 (relay), 5–11 (plugin).
- Narrow `globalThis.fetch` interposer, once per process, delegate to fetch
  active at install → Task 10.
- Version gate rejecting activation before install; peerDependencies
  authoritative → Tasks 6, 11, 12.
- Exact endpoint interception; OAuth/api/auth/other chatgpt.com passthrough →
  Tasks 8, 10.
- URL replacement to `custom-{slug}/v1/responses` mapping → Tasks 8, 9.
- Header preservation + seven control headers verbatim → Task 9.
- Body/signal/method preserved, response returned unchanged → Tasks 9, 10.
- Config table incl. defaults, invalid-value handling, test-only allowlisted
  override → Task 7.
- Fixed three-entry metadata only → Task 9.
- Relay route/auth/fixed-upstream/denylist/Connection-token/response filtering →
  existing code moved in Task 1, regression-tested.
- 30s header timeout 504 body → existing, kept green by suite.
- SSE 120s idle timer, chunk-reset, `upstream_sse_idle_timeout`, no second HTTP
  status → Task 3.
- Post-header cancellation both directions → Task 4.
- No fallback/retry/cache/logging; diagnostics redaction → Tasks 7, 12.
- BYOK compatibility: minimum-version documentation (Task 14) + both load
  order contract tests (Task 12). The best-effort old-version warning is
  intentionally omitted: per spec, the plugin cannot reliably identify BYOK at
  runtime, so identification-based warning has no implementable trigger.
- Contract/CI in normal CI; protected acceptance gated on real credentials →
  Task 13.
- Out-of-scope items (OAuth reimplementation, provisioning automation, octg) —
  intentionally absent.

**2. Placeholder scan:** No TBD/TODO/"implement later"/"similar to Task N"
present. Every code step shows complete code. The only execution-time resolution
is `npm install --save-dev @opencode-ai/plugin` (concrete command, version
resolved by npm — intentional, not a placeholder).

**3. Type consistency:** `ResolvedConfig` fields used identically in Tasks 8, 9,
10, 12 fixtures. `FetchLike`/`ConfigResolver` defined once (Task 10) and
imported thereafter. `HostVersionCapability` shape consistent between Tasks 6
and 11. `RelayDependencies.idleTimeoutMs` introduced in Task 3 and consumed only
there. `SUPPORTED_OPENCODE_RANGE` single source referenced by Tasks 6 and 12.
Import extensions are `.js` throughout the plugin (NodeNext ESM requirement) —
consistent across src and tests.
