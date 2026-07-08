import Link from "next/link";
import CostsDashboard from "@/components/review/CostsDashboard";
import OrgKeyInput from "@/components/review/OrgKeyInput";
import { color } from "@/styles/tokens";

// Costs dashboard (asaya admin only, READ-ONLY). Lives under the review
// layout so the OrgKeyBootstrap ?key= → sessionStorage flow works here too;
// the admin org key travels as X-Org-Key on every /api/admin/costs/* call.
// Partner keys get a friendly 403 screen inside the dashboard component.
export default function CostsPage() {
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
              Costs
            </h1>
            <p style={{ color: color.text.secondary, fontSize: 13, margin: "8px 0 0" }}>
              Operator billing cockpit · admin only · read-only ·{" "}
              <Link href="/review" style={{ color: color.accent.base, textDecoration: "none" }}>
                ← all sessions
              </Link>
            </p>
          </div>
          <OrgKeyInput />
        </header>
        <CostsDashboard />
      </div>
    </main>
  );
}
