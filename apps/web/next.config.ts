import type { NextConfig } from "next";

// The browser only ever talks to our own origin and the stateful server
// (NEXT_PUBLIC_SERVER_URL — Railway in prod). Derive its origin so the CSP
// connect-src can name it exactly instead of falling back to a broad https:.
// Also allow the wss:// variant: the candidate workspace opens a WebSocket to
// the server for the PTY/terminal bridge.
const SERVER_URL = process.env["NEXT_PUBLIC_SERVER_URL"] ?? "http://localhost:3001";
let serverOrigin = SERVER_URL;
let serverWsOrigin = SERVER_URL.replace(/^http/, "ws");
try {
  const u = new URL(SERVER_URL);
  serverOrigin = u.origin;
  serverWsOrigin = `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}`;
} catch {
  /* keep the raw string fallbacks */
}

// Content-Security-Policy.
//
// script-src / style-src carry 'unsafe-inline': Next.js (app router) injects
// inline hydration scripts and this app styles everything with inline style=
// props + a few inline <style> blocks. A nonce-based policy would need request
// middleware and make every page dynamic — not worth it for a marketing site
// plus an admin-gated review surface. The high-value directives here are
// frame-ancestors (clickjacking), connect-src (locks XHR/WebSocket targets to
// our own server), and object-src 'none'.
//
// MONACO_CDN: the candidate IDE (@monaco-editor/react) loads the Monaco editor
// + its web workers from jsdelivr at runtime (it always has — see
// Editor.tsx). The editor mounts a <script> from the CDN, fetches its chunks,
// and spawns blob: workers. So script/connect/font must allow jsdelivr and
// worker-src must allow blob:, or the editor hangs on "Loading…". (Restoring
// what worked pre-CSP; self-hosting Monaco under /monaco is the stricter
// follow-up if we want to drop the CDN dependency.)
const MONACO_CDN = "https://cdn.jsdelivr.net";
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  `script-src 'self' 'unsafe-inline' blob: ${MONACO_CDN}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  `font-src 'self' data: ${MONACO_CDN}`,
  `connect-src 'self' ${serverOrigin} ${serverWsOrigin} ${MONACO_CDN}`,
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  // Clickjacking defense for browsers that predate frame-ancestors.
  { key: "X-Frame-Options", value: "DENY" },
  // Block MIME-type sniffing.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Don't leak full URLs (incl. any ?key=) to third parties on navigation.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Deny powerful features the app never uses. camera stays 'self' for the
  // dormant proctoring-v2 webcam path (same-origin when it activates).
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=()",
  },
  // Belt-and-suspenders HSTS at the app layer (Railway/Vercel also set it).
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  // Transpile the shared workspace package
  transpilePackages: ["@crucible/shared"],

  // Ensure server-only env vars are never bundled into the client
  // NEXT_PUBLIC_* is the only safe surface for the browser
  serverExternalPackages: [],

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
