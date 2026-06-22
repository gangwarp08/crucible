import LandingPage from "@/components/landing/LandingPage";

// Marketing landing page — the public-facing surface that introduces assaya
// and routes to the assessment via "Start the assessment" / "Try the
// simulation" CTAs. The actual scenario start lives at /start/[slug].
export default function HomePage(): React.ReactElement {
  return <LandingPage />;
}
