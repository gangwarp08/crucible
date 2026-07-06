"use client";
// "Talk to us" — public marketing contact page with call booking.
//
// Visitors leave name / work email / what they want to assess and pick a
// 30-minute slot. Availability comes from GET /api/contact/slots, which the
// server derives anonymously from the founder's calendar free/busy: only
// abstract { start, end } windows ever reach this page.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { color, font, radius } from "@/styles/tokens";
import Wordmark from "@/components/ui/Wordmark";
import SectionLabel from "@/components/ui/SectionLabel";
import Button from "@/components/ui/Button";
import {
  getContactSlots,
  bookContact,
  SlotTakenError,
  type ContactSlot,
  type ContactSlotsResult,
} from "@/lib/api";

const MAXW = 760;
const FALLBACK_EMAIL = "hello@asaya.com";

type SlotsPhase =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; result: ContactSlotsResult };

// ─── Formatting helpers (all render in the server-provided timezone) ─────────

function dayLabel(iso: string, tz: string): string {
  const d = new Date(iso);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" })
    .format(d).toUpperCase();
  const monthDay = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" })
    .format(d).toUpperCase();
  return `${weekday} · ${monthDay}`;
}

function timeLabel(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(iso));
}

function tzAbbrev(tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(new Date());
  return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
}

function groupByDay(slots: ContactSlot[], tz: string): Array<{ label: string; slots: ContactSlot[] }> {
  const groups = new Map<string, ContactSlot[]>();
  for (const slot of slots) {
    const label = dayLabel(slot.start, tz);
    const existing = groups.get(label);
    if (existing) existing.push(slot);
    else groups.set(label, [slot]);
  }
  return Array.from(groups, ([label, daySlots]) => ({ label, slots: daySlots }));
}

// ─── Shared styles ────────────────────────────────────────────────────────────

const FIELD_LABEL: CSSProperties = {
  display: "block",
  fontFamily: font.mono,
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: "0.18em",
  textTransform: "uppercase",
  color: color.text.secondary,
  marginBottom: 8,
};

const INPUT: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: color.bg.input,
  border: `1px solid ${color.border.default}`,
  borderRadius: radius.sm,
  color: color.text.primary,
  fontFamily: font.sans,
  fontSize: 14,
  lineHeight: 1.5,
  padding: "12px 14px",
  outline: "none",
};

export default function ContactPage(): React.ReactElement {
  const [slotsPhase, setSlotsPhase] = useState<SlotsPhase>({ kind: "loading" });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [booked, setBooked] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadSlots = useCallback(async () => {
    setSlotsPhase({ kind: "loading" });
    try {
      const result = await getContactSlots();
      setSlotsPhase({ kind: "ready", result });
    } catch {
      setSlotsPhase({ kind: "error" });
    }
  }, []);

  useEffect(() => { void loadSlots(); }, [loadSlots]);

  const schedulingAvailable =
    slotsPhase.kind === "ready" &&
    slotsPhase.result.configured &&
    slotsPhase.result.slots.length > 0;

  const timezone = slotsPhase.kind === "ready" ? slotsPhase.result.timezone : null;

  const dayGroups = useMemo(() => {
    if (slotsPhase.kind !== "ready" || !timezone) return [];
    return groupByDay(slotsPhase.result.slots, timezone);
  }, [slotsPhase, timezone]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!name.trim()) { setFormError("Please tell us your name."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setFormError("Please enter a valid work email."); return;
    }
    if (!query.trim()) { setFormError("Please tell us what you want to assess."); return; }
    if (!selected) { setFormError("Please pick a time for the call."); return; }
    setSubmitting(true);
    try {
      await bookContact({
        name: name.trim(),
        email: email.trim(),
        query: query.trim(),
        slotStart: selected,
      });
      setBooked(true);
    } catch (err) {
      if (err instanceof SlotTakenError) {
        setSelected(null);
        setFormError("That slot was just taken, pick another");
        void loadSlots();
      } else {
        setFormError(`Something went wrong. Try again, or email us at ${FALLBACK_EMAIL}.`);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "100svh",
        background: color.bg.page,
        color: color.text.primary,
        display: "flex",
        justifyContent: "center",
        overflowY: "auto",
        padding: "56px 24px 96px",
      }}
    >
      <div style={{ width: "100%", maxWidth: MAXW }}>
        <header
          style={{
            marginBottom: 48,
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
          }}
        >
          <Wordmark />
          <Button href="/" variant="ghost" size="sm">Back</Button>
        </header>

        {booked ? (
          <BookedScreen email={email.trim()} slotStart={selected} timezone={timezone} />
        ) : (
          <>
            <div style={{ marginBottom: 44 }}>
              <SectionLabel tone="eyebrow">Talk to us</SectionLabel>
              <h1
                style={{
                  fontFamily: font.sans,
                  fontSize: "clamp(2rem, 4.6vw, 2.9rem)",
                  fontWeight: 600,
                  letterSpacing: "-0.03em",
                  lineHeight: 1.08,
                  margin: "20px 0 14px",
                  textWrap: "balance",
                }}
              >
                Book an intro call
              </h1>
              <p style={{ color: color.text.secondary, fontSize: 14.5, lineHeight: 1.65, maxWidth: 520, margin: 0 }}>
                Tell us what you want to assess and pick a time. Thirty minutes,
                no prep needed. A calendar invite lands in your inbox right away.
              </p>
            </div>

            <form onSubmit={(e) => { void handleSubmit(e); }} noValidate>
              <div style={{ display: "grid", gap: 24, marginBottom: 40 }}>
                <div style={{ display: "grid", gap: 24, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
                  <div>
                    <label htmlFor="contact-name" style={FIELD_LABEL}>Name</label>
                    <input
                      id="contact-name"
                      type="text"
                      value={name}
                      maxLength={100}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Your name"
                      style={INPUT}
                      required
                    />
                  </div>
                  <div>
                    <label htmlFor="contact-email" style={FIELD_LABEL}>Work email</label>
                    <input
                      id="contact-email"
                      type="email"
                      value={email}
                      maxLength={200}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@company.com"
                      style={INPUT}
                      required
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="contact-query" style={FIELD_LABEL}>
                    What do you want to assess?
                  </label>
                  <textarea
                    id="contact-query"
                    value={query}
                    maxLength={2000}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Roles, team size, what signal you are missing today"
                    rows={5}
                    style={{ ...INPUT, resize: "vertical", minHeight: 120 }}
                    required
                  />
                </div>
              </div>

              <div style={{ marginBottom: 40 }}>
                <div
                  style={{
                    display: "flex", alignItems: "baseline",
                    justifyContent: "space-between", gap: 16, marginBottom: 20,
                  }}
                >
                  <SectionLabel>Pick a time</SectionLabel>
                  {schedulingAvailable && timezone && (
                    <span
                      style={{
                        fontFamily: font.mono, fontSize: 11, letterSpacing: "0.14em",
                        textTransform: "uppercase", color: color.text.muted,
                      }}
                    >
                      all times {tzAbbrev(timezone)}
                    </span>
                  )}
                </div>

                {slotsPhase.kind === "loading" && (
                  <div style={{ color: color.text.muted, fontSize: 13, fontFamily: font.mono }}>
                    loading availability…
                  </div>
                )}

                {(slotsPhase.kind === "error" ||
                  (slotsPhase.kind === "ready" && !schedulingAvailable)) && (
                  <div
                    style={{
                      border: `1px solid ${color.border.default}`,
                      borderRadius: radius.sm,
                      background: color.bg.panel,
                      padding: "18px 20px",
                      color: color.text.secondary,
                      fontSize: 13.5,
                      lineHeight: 1.6,
                    }}
                  >
                    Online scheduling isn&apos;t available right now. Write your note
                    above and send it by email instead: we read everything at{" "}
                    <a
                      href={`mailto:${FALLBACK_EMAIL}`}
                      style={{ color: color.accent.base, textDecoration: "none" }}
                    >
                      {FALLBACK_EMAIL}
                    </a>
                  </div>
                )}

                {slotsPhase.kind === "ready" && schedulingAvailable && timezone && (
                  <div style={{ display: "grid", gap: 24 }}>
                    {dayGroups.map((group) => (
                      <div key={group.label}>
                        <div
                          style={{
                            fontFamily: font.mono, fontSize: 11, fontWeight: 500,
                            letterSpacing: "0.2em", textTransform: "uppercase",
                            color: color.text.muted, marginBottom: 10,
                          }}
                        >
                          {group.label}
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                          {group.slots.map((slot) => {
                            const isSelected = selected === slot.start;
                            return (
                              <button
                                key={slot.start}
                                type="button"
                                onClick={() => { setSelected(slot.start); setFormError(null); }}
                                aria-pressed={isSelected}
                                style={{
                                  fontFamily: font.mono,
                                  fontSize: 13,
                                  fontWeight: isSelected ? 600 : 400,
                                  padding: "10px 14px",
                                  borderRadius: radius.sm,
                                  cursor: "pointer",
                                  border: `1px solid ${isSelected ? color.accent.base : color.border.default}`,
                                  background: isSelected ? color.accent.soft : color.bg.input,
                                  color: isSelected ? color.accent.base : color.text.primary,
                                  lineHeight: 1,
                                  transition: "border-color 120ms ease, background 120ms ease",
                                }}
                              >
                                {timeLabel(slot.start, timezone)}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {formError && (
                <div
                  style={{
                    marginBottom: 20,
                    color: color.error.base,
                    fontSize: 13,
                    lineHeight: 1.5,
                  }}
                  role="alert"
                >
                  {formError}
                </div>
              )}

              {schedulingAvailable ? (
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  fullWidth
                  disabled={submitting}
                >
                  {submitting ? "Booking…" : "Book the call"}
                </Button>
              ) : (
                // No live slots to book against: the drafted note is still
                // useful, so hand it off to email instead of a dead button.
                <Button
                  href={`mailto:${FALLBACK_EMAIL}?subject=${encodeURIComponent(
                    `asaya intro call: ${name.trim() || "your name"}`,
                  )}&body=${encodeURIComponent(query.trim())}`}
                  variant="primary"
                  size="lg"
                  fullWidth
                >
                  Send by email instead
                </Button>
              )}
              <p
                style={{
                  marginTop: 16,
                  color: color.text.muted,
                  fontSize: 12.5,
                  lineHeight: 1.6,
                }}
              >
                We only use your details to run this call. Prefer email?{" "}
                <a
                  href={`mailto:${FALLBACK_EMAIL}`}
                  style={{ color: color.text.secondary, textDecoration: "underline" }}
                >
                  {FALLBACK_EMAIL}
                </a>
              </p>
            </form>
          </>
        )}
      </div>
    </main>
  );
}

function BookedScreen({
  email, slotStart, timezone,
}: {
  email: string;
  slotStart: string | null;
  timezone: string | null;
}): React.ReactElement {
  return (
    <div style={{ paddingTop: 24 }}>
      <SectionLabel tone="eyebrow">Booked</SectionLabel>
      <h1
        style={{
          fontFamily: font.sans,
          fontSize: "clamp(2rem, 4.6vw, 2.9rem)",
          fontWeight: 600,
          letterSpacing: "-0.03em",
          lineHeight: 1.08,
          margin: "20px 0 14px",
        }}
      >
        Booked. A calendar invite is on its way to {email}.
      </h1>
      {slotStart && timezone && (
        <p
          style={{
            fontFamily: font.mono, fontSize: 13, letterSpacing: "0.06em",
            color: color.text.secondary, margin: "0 0 28px",
          }}
        >
          {dayLabel(slotStart, timezone)} · {timeLabel(slotStart, timezone)} {tzAbbrev(timezone)}
        </p>
      )}
      <p style={{ color: color.text.secondary, fontSize: 14, lineHeight: 1.65, maxWidth: 520, margin: "0 0 36px" }}>
        Talk soon. If the time stops working, reply to the invite or email us
        at {FALLBACK_EMAIL} and we will find another slot.
      </p>
      <Button href="/" variant="ghost" size="md">Back to the site</Button>
    </div>
  );
}
