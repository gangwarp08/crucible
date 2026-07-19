// Dedupe store for the nightly batch. In-memory is fine here: one process
// owns the whole run, and the outbox append is the only side effect.
//
// TODO(platform): when the batch moves to the worker pool this needs to be
// backed by Redis SETNX — tracked in VAN-1132.

export function createDedupeStore() {
  const seen = new Set();
  return {
    /** True if this key has already been dispatched this run. */
    has(key) {
      return seen.has(key);
    },
    /** Record a key as dispatched. Returns false if it was already there. */
    add(key) {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
    size() {
      return seen.size;
    },
  };
}
