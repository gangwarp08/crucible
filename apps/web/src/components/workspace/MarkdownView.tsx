"use client";
import { Fragment, useMemo } from "react";
import { color, radius, font } from "@/styles/tokens";

// Minimal markdown renderer scoped to what the scenario docs use:
// `##` h2 headings, plain paragraphs, fenced ``` code blocks, inline `code`,
// blockquotes (`>`), and `-` bullet lists. No links, images, tables, emphasis,
// or syntax highlighting. Keeps us free of a dependency (no react-markdown or
// remark/rehype tree) and small enough to audit at a glance. The two committed
// scenario docs were authored to fit this subset.

interface Props {
  source: string;
}

interface Block {
  kind: "heading" | "paragraph" | "code" | "blockquote" | "list";
  lines: string[];
}

function parse(source: string): Block[] {
  const out: Block[] = [];
  const lines = source.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        body.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++; // skip closing fence
      out.push({ kind: "code", lines: body });
      continue;
    }

    // Blank line skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Heading
    if (line.startsWith("## ")) {
      out.push({ kind: "heading", lines: [line.slice(3).trim()] });
      i++;
      continue;
    }

    // Blockquote — consume consecutive `> ` lines
    if (line.startsWith("> ") || line === ">") {
      const body: string[] = [];
      while (i < lines.length && (lines[i]!.startsWith("> ") || lines[i] === ">")) {
        body.push(lines[i]!.replace(/^>\s?/, ""));
        i++;
      }
      out.push({ kind: "blockquote", lines: body });
      continue;
    }

    // Bullet list — consume consecutive `- ` lines
    if (line.startsWith("- ")) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("- ")) {
        body.push(lines[i]!.slice(2));
        i++;
      }
      out.push({ kind: "list", lines: body });
      continue;
    }

    // Paragraph — consume until blank line or a block-starting token
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (
        l.trim() === "" ||
        l.startsWith("## ") ||
        l.startsWith("```") ||
        l.startsWith("> ") ||
        l.startsWith("- ")
      ) break;
      para.push(l);
      i++;
    }
    out.push({ kind: "paragraph", lines: para });
  }
  return out;
}

// Inline `code` spans only. No other inline formatting.
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /`([^`]+)`/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(<Fragment key={key++}>{text.slice(lastIdx, match.index)}</Fragment>);
    }
    parts.push(
      <code
        key={key++}
        style={{
          background: color.bg.input,
          color: color.warn.base,
          padding: "1px 5px",
          borderRadius: radius.md,
          fontSize: "0.92em",
          fontFamily: font.mono,
        }}
      >
        {match[1]}
      </code>,
    );
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    parts.push(<Fragment key={key++}>{text.slice(lastIdx)}</Fragment>);
  }
  return parts;
}

export default function MarkdownView({ source }: Props) {
  const blocks = useMemo(() => parse(source), [source]);
  return (
    <div
      style={{
        color: color.text.primary,
        fontSize: 13,
        lineHeight: 1.55,
        fontFamily: font.sans,
      }}
    >
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "heading":
            return (
              <h2
                key={i}
                style={{
                  fontSize: 15,
                  fontWeight: 600,
                  color: color.text.primary,
                  margin: i === 0 ? "0 0 8px" : "20px 0 8px",
                  paddingBottom: 4,
                  borderBottom: `1px solid ${color.border.default}`,
                }}
              >
                {renderInline(b.lines[0]!)}
              </h2>
            );
          case "paragraph":
            return (
              <p key={i} style={{ margin: "0 0 10px" }}>
                {renderInline(b.lines.join(" "))}
              </p>
            );
          case "code":
            return (
              <pre
                key={i}
                style={{
                  background: color.bg.panel,
                  border: `1px solid ${color.border.default}`,
                  borderRadius: radius.lg,
                  padding: "8px 12px",
                  margin: "0 0 12px",
                  overflow: "auto",
                  color: color.text.primary,
                  fontSize: 12,
                  fontFamily: font.mono,
                  lineHeight: 1.45,
                }}
              >
                {b.lines.join("\n")}
              </pre>
            );
          case "blockquote":
            return (
              <blockquote
                key={i}
                style={{
                  margin: "0 0 12px",
                  padding: "6px 12px",
                  borderLeft: `3px solid ${color.accent.base}`,
                  background: color.bg.panel,
                  color: color.text.primary,
                  fontStyle: "normal",
                }}
              >
                {b.lines.map((line, j) => (
                  <div key={j}>{renderInline(line)}</div>
                ))}
              </blockquote>
            );
          case "list":
            return (
              <ul
                key={i}
                style={{
                  margin: "0 0 12px",
                  paddingLeft: 22,
                }}
              >
                {b.lines.map((line, j) => (
                  <li key={j} style={{ marginBottom: 2 }}>
                    {renderInline(line)}
                  </li>
                ))}
              </ul>
            );
        }
      })}
    </div>
  );
}
