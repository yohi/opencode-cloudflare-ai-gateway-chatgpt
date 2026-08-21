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
