/** Wall-clock indirection so tests can freeze time. */
let frozen = null;

export function now() {
  return frozen ?? new Date();
}

export function freeze(date) {
  frozen = date;
}

export function unfreeze() {
  frozen = null;
}

/** ISO string without milliseconds — the outbox line format. */
export function isoSeconds(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
