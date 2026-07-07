import CandidateReport from "./CandidateReport";

interface Props {
  params: Promise<{ token: string }>;
}

// PUBLIC shared candidate report (P4.2/P4.3). No login, no org key — the
// token in the URL is the entire auth; the server validates it (sha256
// lookup, unexpired, not revoked) and returns the external-safe subset only.
export default async function ReportPage({ params }: Props) {
  const { token } = await params;
  return <CandidateReport token={token} />;
}
