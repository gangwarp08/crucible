import SessionsTable from "@/components/review/SessionsTable";
import OrgKeyInput from "@/components/review/OrgKeyInput";
import SessionLinkMintPanel from "@/components/review/SessionLinkMintPanel";
import AdminNavLinks from "@/components/review/AdminNavLinks";
import { color } from "@/styles/tokens";

export default function ReviewPage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "40px 40px 80px",
        overflowY: "auto",
      }}
    >
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
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
              Sessions
            </h1>
            <p style={{ color: color.text.secondary, fontSize: 13, margin: "8px 0 0" }}>
              Recruiter review · sessions in your organization
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {/* Admin-only links (Validity / Costs) — each renders only when
                its probe against /api/admin/* succeeds; hidden for partners. */}
            <AdminNavLinks />
            {/* P2: per-org API key (X-Org-Key). Optional while the server's
                ORG_AUTH_REQUIRED flag is off — key-less requests see the
                default org. */}
            <OrgKeyInput />
          </div>
        </header>
        {/* RD6 + P5.1: single-use candidate start links with optional
            difficulty-band routing (consumed once at session creation). */}
        <SessionLinkMintPanel />
        <SessionsTable />
      </div>
    </main>
  );
}
