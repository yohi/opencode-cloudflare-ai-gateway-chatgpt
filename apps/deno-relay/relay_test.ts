import { createRelayHandler } from "./relay.ts";
import rootDenoConfig from "../../deno.json" with { type: "json" };

const relayToken = "relay-test-token";
const relayAuthorization = `Bearer ${relayToken}`;

type RootDenoConfig = {
  readonly deploy?: {
    readonly runtime?: {
      readonly entrypoint?: string;
    };
  };
};

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function createRequest(headers: HeadersInit = {}): Request {
  return new Request("https://relay.example/v1/responses", {
    method: "POST",
    headers: {
      "X-ChatGPT-Relay-Authorization": relayAuthorization,
      ...headers,
    },
    body: "request-body",
  });
}

Deno.test("configures Deno Deploy to start the relay entrypoint", () => {
  const config = rootDenoConfig as RootDenoConfig;
  assertEquals(
    config.deploy?.runtime?.entrypoint,
    "./apps/deno-relay/main.ts",
    "Deno Deploy entrypoint",
  );
});

function trackActiveAbortListeners(signal: AbortSignal): () => number {
  const activeListeners = new Set<EventListenerOrEventListenerObject>();
  const originalAdd = EventTarget.prototype.addEventListener.bind(signal);
  const originalRemove = EventTarget.prototype.removeEventListener.bind(
    signal,
  );

  Object.defineProperties(signal, {
    addEventListener: {
      configurable: true,
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ): void => {
        if (type === "abort" && listener !== null) {
          activeListeners.add(listener);
        }
        originalAdd(type, listener, options);
      },
    },
    removeEventListener: {
      configurable: true,
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
      ): void => {
        if (type === "abort" && listener !== null) {
          activeListeners.delete(listener);
        }
        originalRemove(type, listener, options);
      },
    },
  });

  return () => activeListeners.size;
}

Deno.test("forwards only authenticated requests and sanitizes hop headers", async () => {
  let upstreamRequest: Request | undefined;
  const handler = createRelayHandler({
    getSecret: () => relayToken,
    fetcher: (input, init) => {
      upstreamRequest = new Request(input, init);
      return Promise.resolve(
        new Response("upstream-body", {
          headers: {
            connection: "X-Response-Internal",
            "X-Response-Internal": "private",
            "content-length": "13",
            "transfer-encoding": "chunked",
            "X-Preserved": "yes",
          },
        }),
      );
    },
  });

  const response = await handler(createRequest({
    Authorization: "Bearer chatgpt-oauth-token",
    "ChatGPT-Account-Id": "account-id",
    "cf-aig-authorization": "Bearer gateway-token",
    "X-Forwarded-Host": "gateway.example",
    Connection: "X-Request-Internal, keep-alive",
    "X-Request-Internal": "private",
  }));

  assertEquals(response.status, 200, "response status");
  assertEquals(await response.text(), "upstream-body", "response body");
  if (upstreamRequest === undefined) {
    throw new Error("upstream request was not made");
  }

  const upstream = upstreamRequest;
  assertEquals(
    upstream.url,
    "https://chatgpt.com/backend-api/codex/responses",
    "upstream URL",
  );
  assertEquals(
    upstream.headers.get("Authorization"),
    "Bearer chatgpt-oauth-token",
    "OAuth authorization",
  );
  assertEquals(
    upstream.headers.get("ChatGPT-Account-Id"),
    "account-id",
    "account ID",
  );
  assertEquals(
    upstream.headers.get("X-ChatGPT-Relay-Authorization"),
    null,
    "relay authorization",
  );
  assertEquals(
    upstream.headers.get("cf-aig-authorization"),
    null,
    "gateway authorization",
  );
  assertEquals(
    upstream.headers.get("X-Forwarded-Host"),
    null,
    "forwarded header",
  );
  assertEquals(
    upstream.headers.get("X-Request-Internal"),
    null,
    "connection-nominated request header",
  );
  assertEquals(
    response.headers.get("connection"),
    null,
    "connection response header",
  );
  assertEquals(
    response.headers.get("X-Response-Internal"),
    null,
    "connection-nominated response header",
  );
  assertEquals(
    response.headers.get("content-length"),
    "13",
    "content length response header",
  );
  assertEquals(
    response.headers.get("transfer-encoding"),
    null,
    "hop-by-hop response header",
  );
  assertEquals(
    response.headers.get("X-Preserved"),
    "yes",
    "preserved response header",
  );
});

Deno.test("rejects missing or invalid relay credentials before fetching upstream", async () => {
  let fetchCalls = 0;
  const handler = createRelayHandler({
    getSecret: () => relayToken,
    fetcher: () => {
      fetchCalls += 1;
      return Promise.resolve(new Response());
    },
  });

  const missingCredentialResponse = await handler(
    new Request("https://relay.example/v1/responses", { method: "POST" }),
  );
  const invalidCredentialResponse = await handler(
    createRequest({
      "X-ChatGPT-Relay-Authorization": "Bearer incorrect-token",
    }),
  );

  assertEquals(
    missingCredentialResponse.status,
    401,
    "missing credential status",
  );
  assertEquals(
    invalidCredentialResponse.status,
    401,
    "invalid credential status",
  );
  assertEquals(fetchCalls, 0, "upstream fetch calls");
});

Deno.test("rejects requests when the relay secret is unavailable", async () => {
  let fetchCalls = 0;
  const handler = createRelayHandler({
    getSecret: () => undefined,
    fetcher: () => {
      fetchCalls += 1;
      return Promise.resolve(new Response());
    },
  });

  const response = await handler(createRequest());

  assertEquals(response.status, 503, "unavailable relay secret status");
  assertEquals(await response.text(), "Service unavailable", "response body");
  assertEquals(fetchCalls, 0, "upstream fetch calls");
});

Deno.test("rejects every route and method other than POST /v1/responses", async () => {
  let fetchCalls = 0;
  const handler = createRelayHandler({
    getSecret: () => relayToken,
    fetcher: () => {
      fetchCalls += 1;
      return Promise.resolve(new Response());
    },
  });

  const wrongPathResponse = await handler(
    new Request("https://relay.example/relay-test-token/responses", {
      method: "POST",
    }),
  );
  const wrongMethodResponse = await handler(
    new Request("https://relay.example/v1/responses", { method: "GET" }),
  );

  assertEquals(wrongPathResponse.status, 404, "wrong path status");
  assertEquals(wrongMethodResponse.status, 404, "wrong method status");
  assertEquals(fetchCalls, 0, "upstream fetch calls");
});

Deno.test("aborts an upstream request that exceeds the header timeout", async () => {
  let upstreamAborted = false;
  const handler = createRelayHandler({
    getSecret: () => relayToken,
    timeoutMs: 0,
    fetcher: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          reject(new Error("missing upstream abort signal"));
          return;
        }

        signal.addEventListener(
          "abort",
          () => {
            upstreamAborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  });

  const response = await handler(createRequest());

  assert(upstreamAborted, "upstream request was not aborted");
  assertEquals(response.status, 504, "timeout response status");
  assertEquals(
    await response.text(),
    '{"error":"upstream_connect_or_header_timeout"}',
    "timeout response body",
  );
});

Deno.test("clears the header timeout after upstream response headers arrive", async () => {
  let clearedTimerId: number | undefined;
  const handler = createRelayHandler({
    getSecret: () => relayToken,
    fetcher: () => Promise.resolve(new Response("upstream-body")),
    timer: {
      schedule: () => 42,
      clear: (timerId) => {
        clearedTimerId = timerId;
      },
    },
  });

  const response = await handler(createRequest());

  assertEquals(response.status, 200, "response status");
  assertEquals(clearedTimerId, 42, "cleared timer ID");
});

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
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
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
  assertEquals(
    errorMessage,
    "upstream_sse_idle_timeout",
    "idle timeout stream error",
  );
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
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
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
  assertEquals(
    scheduleCalls,
    4,
    "header timeout + initial idle + reset per chunk",
  );
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

Deno.test("detaches abort listeners after a non-SSE body completes", async () => {
  const request = createRequest();
  const activeAbortListeners = trackActiveAbortListeners(request.signal);
  const handler = createRelayHandler({
    getSecret: () => relayToken,
    fetcher: () => Promise.resolve(new Response("upstream-body")),
  });

  const response = await handler(request);
  assertEquals(await response.text(), "upstream-body", "response body");
  assertEquals(
    activeAbortListeners(),
    0,
    "active abort listeners after body completion",
  );
});

Deno.test("detaches abort listeners when upstream fetch fails", async () => {
  const request = createRequest();
  const activeAbortListeners = trackActiveAbortListeners(request.signal);
  const handler = createRelayHandler({
    getSecret: () => relayToken,
    fetcher: () => Promise.reject(new Error("upstream unavailable")),
  });

  let thrownError: unknown;
  try {
    await handler(request);
  } catch (error) {
    thrownError = error;
  }

  assert(thrownError instanceof Error, "upstream error was not propagated");
  assertEquals(
    activeAbortListeners(),
    0,
    "active abort listeners after upstream failure",
  );
});

Deno.test("detaches abort listeners when the upstream header timeout expires", async () => {
  const request = createRequest();
  const activeAbortListeners = trackActiveAbortListeners(request.signal);
  const handler = createRelayHandler({
    getSecret: () => relayToken,
    timeoutMs: 0,
    fetcher: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("upstream aborted")),
          { once: true },
        );
      }),
  });

  const response = await handler(request);

  assertEquals(response.status, 504, "timeout response status");
  assertEquals(
    activeAbortListeners(),
    0,
    "active abort listeners after header timeout",
  );
});

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
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
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
  let upstreamCancelled = false;
  const clientController = new AbortController();

  const handler = createRelayHandler({
    getSecret: () => relayToken,
    fetcher: (_input, init) => {
      upstreamSignal = init?.signal ?? undefined;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode("event: response.created\n\n"),
              );
            },
            cancel() {
              upstreamCancelled = true;
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
  await handler(request);
  clientController.abort();

  assert(
    upstreamSignal?.aborted === true,
    "upstream fetch aborted by client disconnect",
  );
  assert(upstreamCancelled, "upstream body cancelled by client disconnect");
});
