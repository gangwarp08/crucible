import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// UI font — loaded once, exposed as a CSS var consumed by tokens.font.sans
// across every component. Removes the four font-stack variants previously
// hard-coded inline.
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

// Monospace — used by the editor, terminal, data-explorer table, and any
// numerics that benefit from tabular-nums (token counts, durations, etc).
const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Crucible",
  description: "AI-conducted coding assessment platform",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
