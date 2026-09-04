import { assertJsonResponse } from "./acceptance_support.ts";

Deno.test("asserts a consumed JSON response without recanceling its body", async () => {
  await assertJsonResponse(new Response('{"ok":true}'), {
    body: '{"ok":true}',
    label: "consumed response",
    status: 200,
  });
});
