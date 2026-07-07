"use client";
// P2 — org API key entry for the review surface.
//
// Org keys must NEVER ship in the browser bundle (no NEXT_PUBLIC_), so the
// reviewer pastes theirs here once per tab. It is kept in sessionStorage
// (crucible.org.key) and lib/api.ts attaches it as X-Org-Key on every
// /api/review/* call. While the server's ORG_AUTH_REQUIRED flag is off, an
// empty key still works — the server falls back to the default org — so this
// stays a small, unobtrusive control rather than a login gate.
import { useEffect, useState } from "react";
import { getStoredOrgKey, storeOrgKey } from "@/lib/api";
import { color } from "@/styles/tokens";

export default function OrgKeyInput({ onChange }: { onChange?: () => void }) {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setValue(getStoredOrgKey() ?? "");
  }, []);

  function save() {
    storeOrgKey(value.trim());
    setSaved(true);
    // Refetch everything under the new key: parent callback when provided
    // (client parents), else a plain reload (the review page is a server
    // component and can't pass a handler down).
    if (onChange) {
      setTimeout(() => setSaved(false), 1500);
      onChange();
    } else {
      window.location.reload();
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <label
        htmlFor="org-key"
        style={{ fontSize: 12, color: color.text.secondary, whiteSpace: "nowrap" }}
      >
        Org key
      </label>
      <input
        id="org-key"
        type="password"
        autoComplete="off"
        placeholder="optional"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") save(); }}
        style={{
          width: 220,
          padding: "4px 8px",
          fontSize: 12,
          color: color.text.primary,
          background: "transparent",
          border: `1px solid ${color.border.default}`,
          borderRadius: 6,
          outline: "none",
        }}
      />
      <button
        type="button"
        onClick={save}
        style={{
          padding: "4px 10px",
          fontSize: 12,
          color: color.text.secondary,
          background: "transparent",
          border: `1px solid ${color.border.default}`,
          borderRadius: 6,
          cursor: "pointer",
        }}
      >
        {saved ? "Saved" : "Set"}
      </button>
    </div>
  );
}
