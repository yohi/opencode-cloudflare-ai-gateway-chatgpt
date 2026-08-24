function readAcceptanceOrigin(): string | undefined {
  try {
    const value = Deno.env.get("RELAY_ACCEPTANCE_ORIGIN");
    return value === undefined || value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}

const origin = readAcceptanceOrigin();
const acceptanceTimeoutMs = 10_000;

Deno.test({
  name: "acceptance: relay rejects wrong method with 404",
  ignore: origin === undefined,
  fn: async () => {
    if (origin === undefined) {
      return;
    }
    const response = await fetch(`${origin}/v1/responses`, {
      method: "GET",
      signal: AbortSignal.timeout(acceptanceTimeoutMs),
    });
    try {
      if (response.status !== 404) {
        throw new Error(`expected 404, received ${response.status}`);
      }
    } finally {
      await response.body?.cancel();
    }
  },
});

Deno.test({
  name: "acceptance: relay rejects missing credentials with 401",
  ignore: origin === undefined,
  fn: async () => {
    if (origin === undefined) {
      return;
    }
    const response = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      signal: AbortSignal.timeout(acceptanceTimeoutMs),
    });
    try {
      if (response.status !== 401) {
        throw new Error(`expected 401, received ${response.status}`);
      }
    } finally {
      await response.body?.cancel();
    }
  },
});
