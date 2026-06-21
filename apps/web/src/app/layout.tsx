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

// Monospace — used for headlines, labels, editor, terminal, and any numerics
// that benefit from tabular-nums. The crucible design system leans heavily
// on Plex Mono for headings and structural copy.
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "tula. — measure what matters",
  description: "The simulation-based assessment for AI engineers — replacing fake signals with real evidence.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
