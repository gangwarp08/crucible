import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetry } from "../src/send/retry.js";

test("returns on first success", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("retries on failure then succeeds", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("flake");
      return "ok";
    },
    { attempts: 3 },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("throws after exhausting attempts", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error("down");
      },
      { attempts: 2 },
    ),
    /down/,
  );
  assert.equal(calls, 2);
});

test("reports each attempt outcome", async () => {
  const seen = [];
  await withRetry(
    async (attempt) => {
      if (attempt === 1) throw new Error("flake");
      return "ok";
    },
    { attempts: 2, onAttempt: (n, outcome) => seen.push([n, outcome]) },
  ).catch(() => {});
  assert.deepEqual(seen, [
    [1, "error"],
    [2, "ok"],
  ]);
});
