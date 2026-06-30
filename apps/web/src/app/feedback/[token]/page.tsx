import FeedbackForm from "./FeedbackForm";

interface Props {
  params: Promise<{ token: string }>;
}

// Public, no-login partner page. The token in the URL is the entire auth — the
// server validates it (unexpired, unused, not revoked) before returning context.
export default async function FeedbackPage({ params }: Props) {
  const { token } = await params;
  return <FeedbackForm token={token} />;
}
