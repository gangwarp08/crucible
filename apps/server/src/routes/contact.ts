// "Talk to us" contact + call booking — GET /api/contact/slots, POST /api/contact.
//
// TWO MODES on POST:
// - slotStart absent (interim, current site behavior): the note is relayed as
//   an email to CONTACT_FORWARD_EMAIL via formsubmit.co — zero credentials.
//   NOTE: the first relayed email is an activation email from FormSubmit;
//   click its link once and subsequent submissions deliver normally.
// - slotStart present: books a calendar slot (requires the GOOGLE_* env).
//
// The founder's Gmail calendar is exposed ANONYMOUSLY: the server consults
// only the freeBusy endpoint and returns abstract { start, end } slots — no
// event names, no attendee info, nothing else ever crosses to the browser.
//
// ── Provisioning the Google refresh token (one-time) ─────────────────────────
// 1. Google Cloud console → create (or reuse) a project → "APIs & Services" →
//    enable the Google Calendar API.
// 2. "Credentials" → create an OAuth 2.0 Client ID (type "Web application").
//    Add https://developers.google.com/oauthplayground to the authorized
//    redirect URIs. Note the client ID + secret.
// 3. Open https://developers.google.com/oauthplayground → gear icon → check
//    "Use your own OAuth credentials" and paste the client ID + secret.
// 4. In step 1, authorize BOTH scopes:
//      https://www.googleapis.com/auth/calendar.events
//      https://www.googleapis.com/auth/calendar.freebusy
//    Sign in with the founder's Gmail and consent (offline access is what the
//    playground requests by default → the exchange returns a refresh token).
// 5. In step 2, "Exchange authorization code for tokens" → copy the
//    refresh_token into GOOGLE_REFRESH_TOKEN, and set GOOGLE_CLIENT_ID /
//    GOOGLE_CLIENT_SECRET to the same OAuth client. GOOGLE_CALENDAR_ID
//    defaults to "primary".
//
// PRIVACY: never log name / email / query. Log outcomes + slot times only.

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { env } from "../env.js";

// ─── OAuth: refresh-token → short-lived access token ─────────────────────────

interface GoogleCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

function googleCreds(): GoogleCreds | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    return null;
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    refreshToken: env.GOOGLE_REFRESH_TOKEN,
  };
}

// Module-level cache; refreshed ~60s before Google's stated expiry.
let cachedAccessToken: { token: string; expiresAtMs: number } | null = null;

async function getAccessToken(creds: GoogleCreds): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAtMs) {
    return cachedAccessToken.token;
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`google token refresh failed: ${res.status}`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("google token refresh returned no access_token");
  const ttlSec = typeof data.expires_in === "number" ? data.expires_in : 3600;
  cachedAccessToken = {
    token: data.access_token,
    expiresAtMs: Date.now() + Math.max(0, ttlSec - 60) * 1000,
  };
  return cachedAccessToken.token;
}

// ─── Timezone math (no deps — resolve the tz offset per-instant via Intl) ────

/** Offset (tz-local minus UTC) in ms at a given instant, for a given IANA tz. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asIfUtc = Date.UTC(
    get("year"), get("month") - 1, get("day"),
    get("hour"), get("minute"), get("second"),
  );
  return asIfUtc - instant.getTime();
}

/** The UTC instant of wall-clock (y, m, d, hh, mm) in `timeZone`. Two-pass
 *  offset resolution handles DST transitions within the 2-week window. */
function zonedTimeToUtc(
  y: number, m: number, d: number, hh: number, mm: number, timeZone: string,
): Date {
  const wallAsUtc = Date.UTC(y, m - 1, d, hh, mm);
  let ts = wallAsUtc - tzOffsetMs(new Date(wallAsUtc), timeZone);
  ts = wallAsUtc - tzOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

/** Calendar date (y/m/d) of `instant` as seen in `timeZone`. */
function calendarDateInTz(instant: Date, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { y: get("year"), m: get("month"), d: get("day") };
}

// ─── Candidate slot generation ───────────────────────────────────────────────

const SLOT_MINUTES = 30;
const DAY_START_HOUR = 10;   // 10:00 in CONTACT_TIMEZONE
const DAY_END_HOUR = 18;     // last slot starts 17:30
const WEEKDAYS_WANTED = 10;
const MAX_SLOTS = 40;
const MIN_LEAD_MS = 24 * 60 * 60 * 1000; // no slot earlier than 24h out

interface Slot { start: Date; end: Date }

/** 30-min candidate slots for the next 10 weekdays, 10:00-18:00 in `timeZone`,
 *  starting no earlier than 24h from `now`. Busy filtering happens later. */
function candidateSlots(now: Date, timeZone: string): Slot[] {
  const earliest = now.getTime() + MIN_LEAD_MS;
  const today = calendarDateInTz(now, timeZone);
  const slots: Slot[] = [];
  let weekdays = 0;
  // Scan enough calendar days to find 10 weekdays (10 weekdays span ≤ 14 days).
  for (let offset = 0; offset < 21 && weekdays < WEEKDAYS_WANTED; offset++) {
    // Noon-UTC anchor keeps the nominal date stable while normalizing d+offset.
    const anchor = new Date(Date.UTC(today.y, today.m - 1, today.d + offset, 12));
    const dow = anchor.getUTCDay();
    if (dow === 0 || dow === 6) continue; // skip Sat/Sun
    weekdays++;
    const y = anchor.getUTCFullYear();
    const m = anchor.getUTCMonth() + 1;
    const d = anchor.getUTCDate();
    for (let hh = DAY_START_HOUR; hh < DAY_END_HOUR; hh++) {
      for (const mm of [0, SLOT_MINUTES]) {
        const start = zonedTimeToUtc(y, m, d, hh, mm, timeZone);
        if (start.getTime() < earliest) continue;
        slots.push({ start, end: new Date(start.getTime() + SLOT_MINUTES * 60_000) });
      }
    }
  }
  return slots;
}

// ─── Google Calendar calls ───────────────────────────────────────────────────

interface BusyInterval { start: number; end: number }

async function fetchBusy(
  accessToken: string, timeMin: string, timeMax: string,
): Promise<BusyInterval[]> {
  const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ timeMin, timeMax, items: [{ id: env.GOOGLE_CALENDAR_ID }] }),
  });
  if (!res.ok) throw new Error(`freeBusy failed: ${res.status}`);
  const data = (await res.json()) as {
    calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }>;
  };
  // A missing calendar entry or a per-calendar error MUST fail loudly. If it
  // silently collapsed to "no busy intervals", a misconfigured calendar id or
  // revoked scope would make every slot look free and let double-bookings
  // through the POST re-check.
  const cal =
    data.calendars?.[env.GOOGLE_CALENDAR_ID] ??
    // freeBusy may echo "primary" back under the account's email address.
    (env.GOOGLE_CALENDAR_ID === "primary" && data.calendars
      ? Object.values(data.calendars)[0]
      : undefined);
  if (!cal || (Array.isArray(cal.errors) && cal.errors.length > 0)) {
    throw new Error("freeBusy returned no usable calendar entry");
  }
  return (cal.busy ?? [])
    .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end));
}

function overlapsBusy(slot: Slot, busy: BusyInterval[]): boolean {
  const s = slot.start.getTime();
  const e = slot.end.getTime();
  return busy.some((b) => s < b.end && e > b.start);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const ContactBody = z
  .object({
    name: z.string().min(1).max(100),
    email: z.string().email().max(200),
    query: z.string().min(1).max(2000),
    // Optional: when present, book that calendar slot; when absent, the
    // submission is relayed as a plain email (interim mode while calendar
    // booking is unconfigured).
    slotStart: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

// ─── Abuse guards ────────────────────────────────────────────────────────────
// The endpoint is unauthenticated and the calendar invite reaches whatever
// email the visitor typed (same property as any Calendly-style booking page),
// so bookings are additionally throttled beyond the per-IP rate limit:
// at most one booking per email per day, and a small global daily cap.

const GLOBAL_DAILY_BOOKING_CAP = 12;
let bookingDay = "";
let bookingsToday = 0;
const bookedEmailsToday = new Set<string>();
// Slots with an insert currently in flight — closes the freeBusy TOCTOU race
// (two concurrent POSTs for the same slot would both pass the re-check before
// Google indexes either event). Single-process server, so in-memory is right.
const slotsInFlight = new Set<number>();

function rollBookingWindow(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== bookingDay) {
    bookingDay = today;
    bookingsToday = 0;
    bookedEmailsToday.clear();
  }
}

/** The invite body reaches the visitor-supplied address, so the free-text
 *  query is kept out of link-clickable form: URLs are defanged and the text
 *  is capped. The full query still reaches the founder via the same field. */
function sanitizeForInvite(text: string): string {
  return text
    .replace(/https?:\/\//gi, "hxxp://")
    .replace(/\bwww\./gi, "www[.]")
    .slice(0, 1200);
}

export async function contactRoutes(server: FastifyInstance) {
  if (!googleCreds()) {
    server.log.warn(
      "[contact] GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN unset — slot booking DISABLED (configured:false)",
    );
  }

  // ─── Anonymous availability ────────────────────────────────────────────
  // Response is cached briefly: staleness is tolerated by design (POST
  // re-checks freeBusy) and the cache keeps a hot loop from burning the
  // Calendar API quota.
  const SLOTS_CACHE_MS = 45_000;
  let slotsCache: { at: number; body: unknown } | null = null;

  server.get(
    "/contact/slots",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const timezone = env.CONTACT_TIMEZONE;
      const creds = googleCreds();
      if (!creds) {
        return reply.send({ configured: false, timezone, slots: [] });
      }
      if (slotsCache && Date.now() - slotsCache.at < SLOTS_CACHE_MS) {
        return reply.send(slotsCache.body);
      }
      try {
        const candidates = candidateSlots(new Date(), timezone);
        if (candidates.length === 0) {
          return reply.send({ configured: true, timezone, slots: [] });
        }
        const token = await getAccessToken(creds);
        const first = candidates[0]!;
        const last = candidates[candidates.length - 1]!;
        const busy = await fetchBusy(token, first.start.toISOString(), last.end.toISOString());
        const free = candidates
          .filter((slot) => !overlapsBusy(slot, busy))
          .slice(0, MAX_SLOTS)
          .map((slot) => ({ start: slot.start.toISOString(), end: slot.end.toISOString() }));
        const body = { configured: true, timezone, slots: free };
        slotsCache = { at: Date.now(), body };
        return reply.send(body);
      } catch (err) {
        request.log.error(
          `[contact] slot lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return reply.status(502).send({ error: "calendar_unavailable" });
      }
    },
  );

  // ─── Book a call / send a note ─────────────────────────────────────────
  server.post(
    "/contact",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = ContactBody.safeParse(request.body);
      if (!parsed.success) {
        // No details echoed back — the body carries PII.
        return reply.status(400).send({ error: "invalid_request" });
      }
      const { name, email, query, slotStart } = parsed.data;

      rollBookingWindow();
      if (bookingsToday >= GLOBAL_DAILY_BOOKING_CAP || bookedEmailsToday.has(email.toLowerCase())) {
        // Daily budget exhausted or repeat email — treated like rate limiting.
        return reply.status(429).send({ error: "too_many_bookings" });
      }

      // ── Interim mode: no slot chosen → relay the note by email ─────────
      if (!slotStart) {
        const forwardTo = env.CONTACT_FORWARD_EMAIL;
        if (!forwardTo) {
          // Inbox not configured on this deployment — nothing to relay to.
          return reply.status(503).send({ error: "relay_unavailable" });
        }
        // FormSubmit rejects requests without an Origin, and activation is
        // per (inbox, origin) pair — so send a STABLE origin: the first
        // configured WEB_ORIGIN. Changing it requires clicking a fresh
        // activation email once.
        const relayOrigin =
          env.WEB_ORIGIN?.split(",")[0]?.trim() || "http://localhost:3000";
        try {
          const res = await fetch(
            `https://formsubmit.co/ajax/${encodeURIComponent(forwardTo)}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                Origin: relayOrigin,
                Referer: `${relayOrigin}/contact`,
              },
              body: JSON.stringify({
                name,
                email,
                message: query,
                _subject: `asaya contact: ${name}`,
                _template: "table",
                _captcha: "false",
              }),
            },
          );
          if (!res.ok) throw new Error(`form relay failed: ${res.status}`);
          bookingsToday++;
          bookedEmailsToday.add(email.toLowerCase());
          request.log.info("[contact] note relayed by email");
          return reply.send({ ok: true });
        } catch (err) {
          request.log.error(
            `[contact] email relay failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          return reply.status(502).send({ error: "relay_unavailable" });
        }
      }

      // ── Booking mode: a slot was chosen → requires calendar creds ──────
      const creds = googleCreds();
      if (!creds) {
        return reply.status(503).send({ error: "scheduling_unavailable" });
      }
      const start = new Date(slotStart);

      // The requested slot must be one the GET endpoint would offer right now
      // (weekday, business hours, 30-min aligned, 24h lead, 10-day horizon).
      // Anything else is rejected BEFORE any Google call — otherwise the 409
      // path becomes a free/busy oracle over the entire calendar and the
      // schema alone would allow booking arbitrary instants.
      const offered = new Set(
        candidateSlots(new Date(), env.CONTACT_TIMEZONE).map((s) => s.start.getTime()),
      );
      if (!offered.has(start.getTime())) {
        return reply.status(400).send({ error: "invalid_request" });
      }
      const end = new Date(start.getTime() + SLOT_MINUTES * 60_000);
      const slotKey = start.getTime();
      if (slotsInFlight.has(slotKey)) {
        return reply.status(409).send({ error: "slot_taken" });
      }
      slotsInFlight.add(slotKey);

      try {
        const token = await getAccessToken(creds);

        // Re-verify the exact 30-min window is still free before writing.
        const busy = await fetchBusy(token, start.toISOString(), end.toISOString());
        if (overlapsBusy({ start, end }, busy)) {
          request.log.info(`[contact] slot taken, booking refused: ${start.toISOString()}`);
          return reply.status(409).send({ error: "slot_taken" });
        }

        const calendarId = encodeURIComponent(env.GOOGLE_CALENDAR_ID);
        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?sendUpdates=all`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              summary: `asaya intro call: ${name}`,
              description: `${sanitizeForInvite(query)}\n\nVisitor email: ${email}\nBooked via the asaya contact page.`,
              start: { dateTime: start.toISOString() },
              end: { dateTime: end.toISOString() },
              attendees: [{ email }],
            }),
          },
        );
        if (!res.ok) {
          // Status only — the response could echo event fields (PII).
          throw new Error(`event insert failed: ${res.status}`);
        }
        bookingsToday++;
        bookedEmailsToday.add(email.toLowerCase());
        slotsCache = null; // the slot just disappeared — drop the cached list
        request.log.info(`[contact] contact booked: ${start.toISOString()}`);
        return reply.send({ ok: true });
      } catch (err) {
        request.log.error(
          `[contact] booking failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return reply.status(502).send({ error: "calendar_unavailable" });
      } finally {
        slotsInFlight.delete(slotKey);
      }
    },
  );
}
