const UPSTREAM = "https://chatgpt.com/backend-api/codex/responses";

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Deno Deploy の warmup / health check を Secret 不要で通す
  if (url.pathname === "/" || url.pathname === "/healthz") {
    return new Response("ok", { status: 200 });
  }

  if (url.pathname === "/debug-secret") {
    const secret = Deno.env.get("RELAY_SECRET") ?? "";

    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(secret),
    );

    const sha256 = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return Response.json({
      configured: secret.length > 0,
      length: secret.length,
      sha256,
    });
  }

  const secret = Deno.env.get("RELAY_SECRET");

  if (!secret) {
    console.error("RELAY_SECRET is not configured");
    return new Response("Service unavailable", { status: 503 });
  }

  if (url.pathname !== `/${secret}/responses`) {
    return new Response("Not Found", { status: 404 });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const headers = new Headers(req.headers);

  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase();

    if (
      lower === "host" ||
      lower === "content-length" ||
      lower === "connection" ||
      lower === "forwarded" ||
      lower === "x-forwarded-for" ||
      lower === "x-forwarded-proto" ||
      lower === "x-real-ip" ||
      lower.startsWith("cf-aig-") ||
      lower.startsWith("cf-")
    ) {
      headers.delete(name);
    }
  }

  const upstream = await fetch(UPSTREAM, {
    method: "POST",
    headers,
    body: req.body,
    redirect: "manual",
  });

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-length");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
});
