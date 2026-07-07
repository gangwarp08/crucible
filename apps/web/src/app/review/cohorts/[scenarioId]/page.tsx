import Link from "next/link";
import CohortDashboard from "@/components/review/CohortDashboard";
import OrgKeyInput from "@/components/review/OrgKeyInput";
import { color } from "@/styles/tokens";

interface Props {
  params: Promise<{ scenarioId: string }>;
}

// P4.1 — per-scenario cohort dashboard. Org-gated like /review (the org key
// travels as X-Org-Key from sessionStorage; while ORG_AUTH_REQUIRED is off a
// key-less request falls back to the default org server-side).
export default async function CohortPage({ params }: Props) {
  const { scenarioId } = await params;
  return (
    <main style={{ minHeight: "100vh", padding: "40px 40px 80px", overflowY: "auto" }}>
      <div style={{ maxWidth: 1400, margin: "0 auto" }}>
        <header
          style={{
            marginBottom: 32,
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div>
            <h1
              style={{
                fontSize: 26,
                fontWeight: 600,
                color: color.text.primary,
                margin: 0,
                letterSpacing: "-0.4px",
              }}
            >
              Cohort
            </h1>
            <p style={{ color: color.text.secondary, fontSize: 13, margin: "8px 0 0" }}>
              Candidates ranked across one scenario ·{" "}
              <Link href="/review" style={{ color: color.accent.base, textDecoration: "none" }}>
                ← all sessions
              </Link>
            </p>
          </div>
          <OrgKeyInput />
        </header>
        <CohortDashboard scenarioId={scenarioId} />
      </div>
    </main>
  );
}
