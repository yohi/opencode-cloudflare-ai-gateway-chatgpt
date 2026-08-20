import { createRelayHandler } from "./relay.ts";

Deno.serve(
  createRelayHandler({
    getSecret: () => Deno.env.get("RELAY_SECRET"),
    fetcher: fetch,
  }),
);
