import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

// UI font — loaded once, exposed as a CSS var consumed by tokens.font.sans
// across every component.
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  display: "swap",
  variable: "--font-sans",
});

// Monospace — used for microlabels, data, editor, terminal, and any numerics
// that benefit from tabular-nums. Headings run Plex Sans; Plex Mono carries
// the structural labels and stats.
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
  variable: "--font-mono",
});

const TITLE = "asaya · metrics that matter. measured with precision.";
const DESCRIPTION =
  "Simulation-based assessment for AI-augmented engineers. A personalized sandbox that scores how people actually work with AI, under real constraints.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: "asaya",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
