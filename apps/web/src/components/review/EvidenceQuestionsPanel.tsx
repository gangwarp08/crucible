"use client";
// Evidence-conversation questions (slice V8) — recruiter prep for the
// follow-up interview about the candidate's OWN recorded work. Each question
// cites the event seqs it probes (clickable context in the timeline). Quietly
// renders nothing on older servers, active sessions, or thin sessions.
import { useEffect, useState } from "react";
import { getEvidenceQuestions, type EvidenceQuestion } from "@/lib/api";
import { color, radius, font } from "@/styles/tokens";

interface Props {
  sessionId: string;
}

type Fetch =
  | { kind: "loading" }
  | { kind: "loaded"; questions: EvidenceQuestion[] | null };

export default function EvidenceQuestionsPanel({ sessionId }: Props) {
  const [fetch, setFetch] = useState<Fetch>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setFetch({ kind: "loading" });
    void getEvidenceQuestions(sessionId).then((questions) => {
      if (!cancelled) setFetch({ kind: "loaded", questions });
    });
    return () => { cancelled = true; };
  }, [sessionId]);

  if (fetch.kind === "loading" || !fetch.questions) return null;

  return (
    <div
      style={{
        background: color.bg.panel,
        border: `1px solid ${color.border.default}`,
        borderRadius: radius.md,
        padding: 16,
        fontFamily: font.sans,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: color.text.primary, marginBottom: 4 }}>
        Evidence conversation
      </div>
      <div style={{ fontSize: 11, color: color.text.muted, marginBottom: 12, lineHeight: 1.5 }}>
        Interview questions generated from this session&apos;s highest-information
        moments — ask about reasoning, within ~48 hours. Only the person who did
        the work answers these fluently.
      </div>
      <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 10 }}>
        {fetch.questions.map((q, i) => (
          <li key={i} style={{ fontSize: 12, color: color.text.secondary, lineHeight: 1.5 }}>
            {q.question}
            <div style={{ fontSize: 11, color: color.text.muted, marginTop: 2 }}>
              {q.rationale}
              {q.eventSeqs.length > 0 ? ` · events ${q.eventSeqs.join(", ")}` : ""}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
