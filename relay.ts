export const UPSTREAM = "https://chatgpt.com/backend-api/codex/responses";

const relayPath = "/v1/responses";
const relayAuthorizationHeader = "x-chatgpt-relay-authorization";
const upstreamHeaderTimeoutMs = 30_000;
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

export function createRelayHandler(
  dependencies: RelayDependencies,
): (request: Request) => Promise<Response> {
  const timeoutMs = dependencies.timeoutMs ?? upstreamHeaderTimeoutMs;
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
    request.signal.addEventListener("abort", abortForClientDisconnect, { once: true });
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

      return new Response(upstream.body, {
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
      request.signal.removeEventListener("abort", abortForClientDisconnect);
    }
  };
}
