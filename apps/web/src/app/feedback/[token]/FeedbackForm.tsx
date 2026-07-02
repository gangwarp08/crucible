"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getOutcomeInvite,
  submitOutcomeInvite,
  NotFoundError,
  type OutcomeInviteContext,
} from "@/lib/api";

const LABELS: Record<string, string> = {
  hired: "Did you hire this candidate?",
  ramp_weeks: "How many weeks to ramp to productivity?",
  manager_rating_90d: "90-day manager rating (1–5)",
  retained_90d: "Still employed at 90 days?",
};

const page: React.CSSProperties = {
  minHeight: "100vh",
  background: "#FBF7EF",
  color: "#28352F",
  fontFamily: "var(--font-sans, ui-sans-serif, system-ui, sans-serif)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "48px 20px",
};
const card: React.CSSProperties = {
  width: "100%",
  maxWidth: 520,
  background: "#FBF6EA",
  border: "1px solid #E7DDCB",
  borderRadius: 12,
  padding: 28,
};
const fieldWrap: React.CSSProperties = { marginBottom: 18 };
const labelStyle: React.CSSProperties = { display: "block", fontSize: 14, marginBottom: 6, color: "#28352F" };
const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "#FBF7EF",
  border: "1px solid #D8CCB6",
  borderRadius: 6,
  color: "#28352F",
  padding: "8px 10px",
  fontSize: 14,
};

export default function FeedbackForm({ token }: { token: string }) {
  const [ctx, setCtx] = useState<OutcomeInviteContext | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [values, setValues] = useState<Record<string, boolean | number | "">>({});
  const [candidateRef, setCandidateRef] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    getOutcomeInvite(token)
      .then(setCtx)
      .catch((e) => {
        if (e instanceof NotFoundError) setNotFound(true);
        else setLoadErr(e instanceof Error ? e.message : String(e));
      });
  }, [token]);

  const setVal = useCallback((type: string, v: boolean | number | "") => {
    setValues((prev) => ({ ...prev, [type]: v }));
  }, []);

  const onSubmit = useCallback(async () => {
    setSubmitting(true);
    setSubmitErr(null);
    // Drop blanks; the server requires at least one value.
    const payload: Record<string, boolean | number> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v === "" || v === undefined) continue;
      payload[k] = v;
    }
    if (Object.keys(payload).length === 0) {
      setSubmitErr("Please fill in at least one field.");
      setSubmitting(false);
      return;
    }
    try {
      await submitOutcomeInvite(token, payload, candidateRef || undefined);
      setDone(true);
    } catch (e) {
      setSubmitErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [token, values, candidateRef]);

  // ── Terminal states ──────────────────────────────────────────────────────
  function Shell({ children }: { children: React.ReactNode }) {
    return (
      <main style={page}>
        <div style={card}>{children}</div>
      </main>
    );
  }

  if (notFound) {
    return (
      <Shell>
        <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>Link not found</h1>
        <p style={{ color: "#5E6B64", fontSize: 14 }}>
          This feedback link is invalid or no longer exists. Please ask for a new one.
        </p>
      </Shell>
    );
  }
  if (loadErr) {
    return (
      <Shell>
        <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>Something went wrong</h1>
        <p style={{ color: "#BC4B3C", fontSize: 14 }}>{loadErr}</p>
      </Shell>
    );
  }
  if (!ctx) {
    return (
      <Shell>
        <p style={{ color: "#5E6B64", fontSize: 14 }}>Loading…</p>
      </Shell>
    );
  }
  if (done || ctx.status === "submitted") {
    return (
      <Shell>
        <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>Thank you ✓</h1>
        <p style={{ color: "#5E6B64", fontSize: 14 }}>
          Your feedback has been recorded. You can close this page.
        </p>
      </Shell>
    );
  }
  if (ctx.status === "expired" || ctx.status === "revoked") {
    return (
      <Shell>
        <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>
          This link is no longer active
        </h1>
        <p style={{ color: "#5E6B64", fontSize: 14 }}>
          The feedback link has {ctx.status === "expired" ? "expired" : "been revoked"}. Please ask
          for a new one.
        </p>
      </Shell>
    );
  }

  // ── Active form ────────────────────────────────────────────────────────────
  return (
    <Shell>
      <h1 style={{ fontSize: 18, margin: "0 0 4px" }}>Candidate outcome feedback</h1>
      <p style={{ color: "#5E6B64", fontSize: 13, margin: "0 0 20px" }}>
        {ctx.scenario_title ? `Assessment: ${ctx.scenario_title}. ` : ""}
        Fill in whatever you know — every field is optional, but please provide at least one.
      </p>

      {ctx.outcome_types.map((type) => (
        <div key={type} style={fieldWrap}>
          <label style={labelStyle}>{LABELS[type] ?? type}</label>
          {type === "hired" || type === "retained_90d" ? (
            <select
              style={inputStyle}
              value={values[type] === true ? "yes" : values[type] === false ? "no" : ""}
              onChange={(e) =>
                setVal(type, e.target.value === "" ? "" : e.target.value === "yes")
              }
            >
              <option value="">— select —</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          ) : type === "manager_rating_90d" ? (
            <select
              style={inputStyle}
              value={values[type] === "" || values[type] === undefined ? "" : String(values[type])}
              onChange={(e) => setVal(type, e.target.value === "" ? "" : Number(e.target.value))}
            >
              <option value="">— select —</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="number"
              min={0}
              style={inputStyle}
              value={values[type] === "" || values[type] === undefined ? "" : String(values[type])}
              onChange={(e) => setVal(type, e.target.value === "" ? "" : Number(e.target.value))}
            />
          )}
        </div>
      ))}

      <div style={fieldWrap}>
        <label style={labelStyle}>Your internal candidate reference (optional)</label>
        <input
          style={inputStyle}
          value={candidateRef}
          onChange={(e) => setCandidateRef(e.target.value)}
          placeholder="e.g. your ATS id"
        />
      </div>

      {submitErr && <p style={{ color: "#BC4B3C", fontSize: 13, marginBottom: 12 }}>{submitErr}</p>}

      <button
        onClick={() => void onSubmit()}
        disabled={submitting}
        style={{
          width: "100%",
          background: submitting ? "#E0D6C4" : "#C67C5B",
          color: "#fff",
          border: "none",
          borderRadius: 8,
          padding: "11px 0",
          fontSize: 15,
          fontWeight: 600,
          cursor: submitting ? "default" : "pointer",
        }}
      >
        {submitting ? "Submitting…" : "Submit feedback"}
      </button>
    </Shell>
  );
}
