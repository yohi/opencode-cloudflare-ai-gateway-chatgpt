import { createRelayHandler } from "./relay.ts";

const relayToken = "relay-test-token";
const relayAuthorization = `Bearer ${relayToken}`;

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

Deno.test("forwards only authenticated requests and sanitizes hop headers", async () => {
  let upstreamRequest: Request | undefined;
  const handler = createRelayHandler({
    getSecret: () => relayToken,
    fetcher: (input, init) => {
      upstreamRequest = new Request(input, init);
      return Promise.resolve(new Response("upstream-body", {
        headers: {
          connection: "X-Response-Internal",
          "X-Response-Internal": "private",
          "content-length": "13",
          "transfer-encoding": "chunked",
          "X-Preserved": "yes",
        },
      }));
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
  assertEquals(upstream.url, "https://chatgpt.com/backend-api/codex/responses", "upstream URL");
  assertEquals(upstream.headers.get("Authorization"), "Bearer chatgpt-oauth-token", "OAuth authorization");
  assertEquals(upstream.headers.get("ChatGPT-Account-Id"), "account-id", "account ID");
  assertEquals(upstream.headers.get("X-ChatGPT-Relay-Authorization"), null, "relay authorization");
  assertEquals(upstream.headers.get("cf-aig-authorization"), null, "gateway authorization");
  assertEquals(upstream.headers.get("X-Forwarded-Host"), null, "forwarded header");
  assertEquals(upstream.headers.get("X-Request-Internal"), null, "connection-nominated request header");
  assertEquals(response.headers.get("connection"), null, "connection response header");
  assertEquals(response.headers.get("X-Response-Internal"), null, "connection-nominated response header");
  assertEquals(response.headers.get("content-length"), "13", "content length response header");
  assertEquals(response.headers.get("transfer-encoding"), null, "hop-by-hop response header");
  assertEquals(response.headers.get("X-Preserved"), "yes", "preserved response header");
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
    createRequest({ "X-ChatGPT-Relay-Authorization": "Bearer incorrect-token" }),
  );

  assertEquals(missingCredentialResponse.status, 401, "missing credential status");
  assertEquals(invalidCredentialResponse.status, 401, "invalid credential status");
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
    new Request("https://relay.example/relay-test-token/responses", { method: "POST" }),
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
