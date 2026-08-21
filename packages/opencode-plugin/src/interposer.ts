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

const globalScope = globalThis as unknown as FlaggedTarget;

export function installFetchInterposer(deps: {
  readonly resolveConfig: ConfigResolver;
  readonly target?: { fetch: FetchLike };
}): void {
  const target: FlaggedTarget = deps.target ?? globalScope;
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
