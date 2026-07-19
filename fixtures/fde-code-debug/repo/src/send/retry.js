// Shared retry wrapper for the send path.
//
// The downstream relay used to flake under load (VAN-887), so every send goes
// through withRetry. Failures are logged per attempt; a delivery that exhausts
// its attempts is logged as status=failed and the batch keeps going.
//
// TODO(oncall): if the process crashes between the outbox append and the log
// line, a re-run could double-send everything after the crash point — we've
// never actually seen it happen, but it comes up in every incident review.

export const DEFAULT_ATTEMPTS = 3;
export const BACKOFF_MS = [0, 250, 1000];

export async function withRetry(fn, { attempts = DEFAULT_ATTEMPTS, onAttempt } = {}) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const result = await fn(i);
      if (onAttempt) onAttempt(i, "ok");
      return result;
    } catch (err) {
      lastErr = err;
      if (onAttempt) onAttempt(i, "error");
      const backoff = BACKOFF_MS[Math.min(i - 1, BACKOFF_MS.length - 1)];
      if (i < attempts && backoff > 0) {
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}
