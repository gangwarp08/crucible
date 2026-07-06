"use client";
// "Talk to us" — public marketing contact page.
//
// Interim mode: visitors leave name / work email / what they want to assess
// and the note is relayed to us by email (POST /api/contact without a slot).
// The calendar slot picker returns once the server has Google credentials —
// see apps/server/src/routes/contact.ts for both modes.

import { useState } from "react";
import type { CSSProperties } from "react";
import { color, font, radius } from "@/styles/tokens";
import Wordmark from "@/components/ui/Wordmark";
import SectionLabel from "@/components/ui/SectionLabel";
import Button from "@/components/ui/Button";
import { bookContact } from "@/lib/api";

const MAXW = 760;

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
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [query, setQuery] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!name.trim()) { setFormError("Please tell us your name."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setFormError("Please enter a valid work email."); return;
    }
    if (!query.trim()) { setFormError("Please tell us what you want to assess."); return; }
    setSubmitting(true);
    try {
      await bookContact({
        name: name.trim(),
        email: email.trim(),
        query: query.trim(),
      });
      setSent(true);
    } catch {
      setFormError("Something went wrong. Please try again in a moment.");
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

        {sent ? (
          <SentScreen email={email.trim()} />
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
                Tell us what you want to assess
              </h1>
              <p style={{ color: color.text.secondary, fontSize: 14.5, lineHeight: 1.65, maxWidth: 520, margin: 0 }}>
                Leave a note and we get back to you within a day to set up a
                free pilot. No prep needed.
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

              <Button
                type="submit"
                variant="primary"
                size="lg"
                fullWidth
                disabled={submitting}
              >
                {submitting ? "Sending…" : "Send the note"}
              </Button>
              <p
                style={{
                  marginTop: 16,
                  color: color.text.muted,
                  fontSize: 12.5,
                  lineHeight: 1.6,
                }}
              >
                We only use your details to reply.
              </p>
            </form>
          </>
        )}
      </div>
    </main>
  );
}

function SentScreen({ email }: { email: string }): React.ReactElement {
  return (
    <div style={{ paddingTop: 24 }}>
      <SectionLabel tone="eyebrow">Sent</SectionLabel>
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
        Got it. We reply to {email} within a day.
      </h1>
      <p style={{ color: color.text.secondary, fontSize: 14, lineHeight: 1.65, maxWidth: 520, margin: "0 0 36px" }}>
        We read every note ourselves.
      </p>
      <Button href="/" variant="ghost" size="md">Back to the site</Button>
    </div>
  );
}
