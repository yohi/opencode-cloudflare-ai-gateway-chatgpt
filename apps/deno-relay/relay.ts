export const UPSTREAM = "https://chatgpt.com/backend-api/codex/responses";

const relayPath = "/v1/responses";
const relayAuthorizationHeader = "x-chatgpt-relay-authorization";
const upstreamHeaderTimeoutMs = 30_000;
const sseIdleTimeoutMs = 120_000;
const sseContentTypeMarker = "text/event-stream";
const requestHeadersToRemove = new Set([
  "connection",
  "content-length",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-real-ip",
]);
const responseHopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type RelayFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type RelayTimer = {
  readonly clear: (timerId: number) => void;
  readonly schedule: (callback: () => void, delayMs: number) => number;
};

export type RelayDependencies = {
  readonly fetcher: RelayFetcher;
  readonly getSecret: () => string | undefined;
  readonly timer?: RelayTimer;
  readonly timeoutMs?: number;
  readonly idleTimeoutMs?: number;
};

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

function connectionHeaderNames(headers: Headers): readonly string[] {
  const connection = headers.get("connection");
  if (connection === null) {
    return [];
  }

  return connection
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
}

function mustRemoveRequestHeader(name: string): boolean {
  return (
    requestHeadersToRemove.has(name) ||
    name === relayAuthorizationHeader ||
    name.startsWith("cf-aig-") ||
    name.startsWith("cf-") ||
    name.startsWith("x-forwarded-")
  );
}

function sanitizeRequestHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  const connectionNames = connectionHeaderNames(headers);

  for (const name of [...headers.keys()]) {
    if (mustRemoveRequestHeader(name.toLowerCase())) {
      headers.delete(name);
    }
  }

  for (const name of connectionNames) {
    headers.delete(name);
  }

  return headers;
}

function sanitizeResponseHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  const connectionNames = connectionHeaderNames(headers);

  for (const name of [...headers.keys()]) {
    if (responseHopByHopHeaders.has(name.toLowerCase())) {
      headers.delete(name);
    }
  }

  for (const name of connectionNames) {
    headers.delete(name);
  }

  return headers;
}

function createSseIdleTimeoutStream(
  upstreamBody: ReadableStream<Uint8Array>,
  options: {
    readonly controller: AbortController;
    readonly timer: RelayTimer;
    readonly idleTimeoutMs: number;
    readonly onFinished?: () => void;
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
          finishStream();
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
      finishStream();
      try {
        await reader.cancel(reason);
      } catch {
        void reason;
      }
      options.controller.abort();
    },
  });
}

export function createRelayHandler(
  dependencies: RelayDependencies,
): (request: Request) => Promise<Response> {
  const timeoutMs = dependencies.timeoutMs ?? upstreamHeaderTimeoutMs;
  const idleTimeoutMs = dependencies.idleTimeoutMs ?? sseIdleTimeoutMs;
  const timer: RelayTimer = dependencies.timer ?? {
    clear: clearTimeout,
    schedule: (callback, delayMs) => Number(setTimeout(callback, delayMs)),
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== relayPath) {
      return notFound();
    }

    const secret = dependencies.getSecret();
    if (secret === undefined || secret.length === 0) {
      return new Response("Service unavailable", { status: 503 });
    }

    if (request.headers.get(relayAuthorizationHeader) !== `Bearer ${secret}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const controller = new AbortController();
    let timedOut = false;
    const abortForClientDisconnect = (): void => controller.abort();
    request.signal.addEventListener("abort", abortForClientDisconnect, {
      once: true,
    });
    const timeoutId = timer.schedule(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const upstream = await dependencies.fetcher(UPSTREAM, {
        method: "POST",
        headers: sanitizeRequestHeaders(request.headers),
        body: request.body,
        redirect: "manual",
        signal: controller.signal,
      });

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

      return new Response(body, {
        status: upstream.status,
        headers: sanitizeResponseHeaders(upstream.headers),
      });
    } catch (error) {
      if (timedOut) {
        return Response.json(
          { error: "upstream_connect_or_header_timeout" },
          { status: 504 },
        );
      }

      throw error;
    } finally {
      timer.clear(timeoutId);
    }
  };
}
