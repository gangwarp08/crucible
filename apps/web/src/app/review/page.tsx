import SessionsTable from "@/components/review/SessionsTable";

export default function ReviewPage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#1e1e1e",
        color: "#cccccc",
        fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
        padding: "32px 40px",
      }}
    >
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        <header style={{ marginBottom: 24 }}>
          <h1
            style={{
              fontSize: 24,
              fontWeight: 600,
              color: "#ffffff",
              margin: 0,
              letterSpacing: "-0.3px",
            }}
          >
            Sessions
          </h1>
          <p style={{ color: "#858585", fontSize: 13, margin: "6px 0 0" }}>
            Recruiter review · all sessions across candidates
          </p>
        </header>
        <SessionsTable />
      </div>
    </main>
  );
}
