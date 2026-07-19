import { test } from "node:test";
import assert from "node:assert/strict";
import { createDedupeStore } from "../src/dispatch/store.js";

test("add returns true first time, false after", () => {
  const store = createDedupeStore();
  assert.equal(store.add("k1"), true);
  assert.equal(store.add("k1"), false);
});

test("has reflects added keys", () => {
  const store = createDedupeStore();
  assert.equal(store.has("k1"), false);
  store.add("k1");
  assert.equal(store.has("k1"), true);
});

test("size counts distinct keys", () => {
  const store = createDedupeStore();
  store.add("a");
  store.add("b");
  store.add("a");
  assert.equal(store.size(), 2);
});
