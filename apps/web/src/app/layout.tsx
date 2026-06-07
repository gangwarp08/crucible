import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Crucible",
  description: "AI-conducted coding assessment platform",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, background: "#1e1e1e" }}>
        {children}
      </body>
    </html>
  );
}
