/**
 * verify-egress.ts — H3 (Slice 6.8c) acceptance.
 *
 * Spins a real E2B sandbox with the SAME option production now uses
 * (allowInternetAccess: false) and asserts:
 *   - an outbound request to an external host FAILS (default-deny egress);
 *   - local compute still WORKS (assessment functionality intact).
 *
 * Costs one real sandbox (~like verify-submit-lock). Exit 0 on PASS, non-zero on
 * FAIL. SKIPs (non-failing) when E2B_API_KEY is absent.
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

async function main(): Promise<void> {
  console.log("verify-egress — H3 (Slice 6.8c)");
  if (!process.env.E2B_API_KEY) {
    console.log("  ⚠ SKIP — E2B_API_KEY absent");
    process.exit(0);
  }
  const { Sandbox } = await import("e2b");

  // Same template + option as production (services/sandbox.ts).
  const sandbox = await Sandbox.create("crucible-dev", {
    timeoutMs: 60_000,
    metadata: { sessionId: "verify-egress" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    allowInternetAccess: false,
  } as any);

  try {
    // ── egress must be DENIED — outbound to an external host fails ──
    let egressBlocked = false;
    let egressDetail = "";
    try {
      const r = await sandbox.commands.run(
        "curl -sS -m 8 -o /dev/null -w '%{http_code}' https://example.com",
        { timeoutMs: 20_000 },
      );
      // If curl returns at all with a 2xx/3xx, egress got through.
      egressDetail = `exit=${r.exitCode} out=${(r.stdout || "").slice(0, 40)}`;
      egressBlocked = r.exitCode !== 0 || !/^[23]\d\d$/.test((r.stdout || "").trim());
    } catch (err) {
      // A thrown CommandExitError (non-zero) is exactly the block we want.
      egressBlocked = true;
      egressDetail = err instanceof Error ? err.message.slice(0, 60) : String(err);
    }
    check("external HTTPS egress is DENIED", egressBlocked, egressDetail);

    // ── a second host, to be sure it's a default-deny and not host-specific ──
    let dnsBlocked = false;
    try {
      const r = await sandbox.commands.run("curl -sS -m 8 -o /dev/null -w '%{http_code}' https://api.github.com", {
        timeoutMs: 20_000,
      });
      dnsBlocked = r.exitCode !== 0 || !/^[23]\d\d$/.test((r.stdout || "").trim());
    } catch {
      dnsBlocked = true;
    }
    check("second external host also DENIED (default-deny)", dnsBlocked);

    // ── local compute still WORKS (functionality intact) ──
    const local = await sandbox.commands.run("python3 -c \"print(6*7)\"", { timeoutMs: 15_000 });
    check("local compute works (python)", local.exitCode === 0 && local.stdout.trim() === "42", `exit=${local.exitCode} out=${local.stdout.trim()}`);

    const fsWrite = await sandbox.commands.run("echo hello > /tmp/e.txt && cat /tmp/e.txt", { timeoutMs: 15_000 });
    check("local filesystem works", fsWrite.exitCode === 0 && fsWrite.stdout.includes("hello"));
  } finally {
    await sandbox.kill().catch(() => {});
  }

  console.log(`\n${failed === 0 ? "PASS" : `FAIL (${failed} check(s))`}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
