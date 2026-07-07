import SessionsTable from "@/components/review/SessionsTable";
import OrgKeyInput from "@/components/review/OrgKeyInput";
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
          {/* P2: per-org API key (X-Org-Key). Optional while the server's
              ORG_AUTH_REQUIRED flag is off — key-less requests see the
              default org. */}
          <OrgKeyInput />
        </header>
        <SessionsTable />
      </div>
    </main>
  );
}
