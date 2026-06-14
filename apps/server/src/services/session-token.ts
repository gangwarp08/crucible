// Per-session JWT — binds each session to a server-signed bearer token.
//
// Threat model: a session UUID surfaces in the candidate's browser URL.
// Without a binding, anyone who lifts that UUID (shared link, screen-share,
// browser-history extension) can drive the AI assistant and personas on the
// candidate's tab and budget. With a JWT bound to {sessionId}, a leaked URL
// is useless without the matching token.
//
// Token shape: `{sessionId, iat, exp}` signed HS256 with env.JWT_SECRET.
// `exp` is capped at TOKEN_MAX_MINUTES from issuance — a defensive ceiling
// independent of SESSION_TIMEOUT_MIN, so a misconfigured 4-hour session
// doesn't ship 4-hour bearer tokens.
//
// HTTP routes: candidate sends `Authorization: Bearer <jwt>`.
// WS routes:   candidate passes `bearer.<jwt>` as a WebSocket subprotocol.
//              Server echoes the negotiated protocol per RFC 6455.
//
// Implemented with Node's built-in `crypto` rather than a JWT library so we
// don't add a new dependency. The format is a strict subset of RFC 7519:
// header `{"alg":"HS256","typ":"JWT"}`, JSON payload, HMAC-SHA256 signature.
// base64url encoding (RFC 4648 §5) on all three segments.

import { createHmac, timingSafeEqual } from "crypto";
import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from "fastify";
import type { IncomingMessage } from "http";
import { env } from "../env.js";

/** Hard ceiling on token lifetime, regardless of SESSION_TIMEOUT_MIN. A
 *  misconfigured session can't issue a longer-lived bearer than this. */
export const TOKEN_MAX_MINUTES = 90;

interface SessionTokenPayload {
  sessionId: string;
  iat: number;
  exp: number;
}

// Static HS256 header — same bytes on every token.
const HEADER_B64 = b64urlEncode(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function hmac(secret: string, signingInput: string): Buffer {
  return createHmac("sha256", secret).update(signingInput).digest();
}

/** Sign a session token. `deadlineMs` is the session's natural expiry;
 *  exp = min(deadline / 1000, now + TOKEN_MAX_MINUTES * 60). */
export function signToken(sessionId: string, deadlineMs: number): string {
  const secret = env.JWT_SECRET;
  if (!secret) {
    // Defensive — env.ts validates JWT_SECRET is required; unreachable in prod.
    throw new Error("JWT_SECRET missing — cannot sign session tokens");
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const deadlineSec = Math.floor(deadlineMs / 1000);
  const maxExp = nowSec + TOKEN_MAX_MINUTES * 60;
  const exp = Math.min(deadlineSec, maxExp);
  const payload: SessionTokenPayload = { sessionId, iat: nowSec, exp };
  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${HEADER_B64}.${payloadB64}`;
  const sigB64 = b64urlEncode(hmac(secret, signingInput));
  return `${signingInput}.${sigB64}`;
}

/** Verify + decode. Returns null on any failure (bad signature, expired,
 *  malformed, missing sessionId). Never throws. Uses constant-time compare. */
export function verifyToken(token: string): SessionTokenPayload | null {
  const secret = env.JWT_SECRET;
  if (!secret) return null;
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  // Recompute and constant-time compare signature.
  const signingInput = `${headerB64}.${payloadB64}`;
  const expected = hmac(secret, signingInput);
  let provided: Buffer;
  try { provided = b64urlDecode(sigB64); } catch { return null; }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  // Parse + validate payload.
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString("utf8")) as Record<string, unknown>;
  } catch { return null; }
  if (typeof payload.sessionId !== "string") return null;
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") return null;

  // Expiry check.
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec >= payload.exp) return null;

  return { sessionId: payload.sessionId, iat: payload.iat, exp: payload.exp };
}

/** Extract the bearer token from an Authorization header. Tolerant of casing. */
function readBearerHeader(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1]! : null;
}

/** Fastify preHandler that enforces the JWT. `extractor` returns the
 *  session ID this route is operating on; 401 if the token's payload
 *  doesn't match. */
export function requireSessionToken(
  extractor: (req: FastifyRequest) => string | undefined,
): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = readBearerHeader(req.headers.authorization);
    if (!raw) {
      reply.status(401).send({ error: "missing_token", message: "Authorization header required" });
      return reply;
    }
    const payload = verifyToken(raw);
    if (!payload) {
      reply.status(401).send({ error: "invalid_token", message: "Token invalid or expired" });
      return reply;
    }
    const expected = extractor(req);
    if (!expected) {
      reply.status(400).send({ error: "missing_session", message: "Session identifier missing from request" });
      return reply;
    }
    if (payload.sessionId !== expected) {
      reply.status(401).send({ error: "session_mismatch", message: "Token does not match this session" });
      return reply;
    }
  };
}

/** Verify the JWT carried in a WebSocket `Sec-WebSocket-Protocol` header.
 *  Returns the payload on success, or null on any failure. */
export function verifyWsToken(
  req: IncomingMessage,
  expectedSessionId: string,
): SessionTokenPayload | null {
  const header = req.headers["sec-websocket-protocol"];
  if (!header) return null;
  const protocols = (Array.isArray(header) ? header.join(",") : header)
    .split(",")
    .map((s) => s.trim());
  const bearer = protocols.find((p) => p.startsWith("bearer."));
  if (!bearer) return null;
  const token = bearer.slice("bearer.".length);
  const payload = verifyToken(token);
  if (!payload) return null;
  if (payload.sessionId !== expectedSessionId) return null;
  return payload;
}
