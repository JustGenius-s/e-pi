import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { APPEARANCE_MAX, APPEARANCE_MIN, type AppearanceKey, useAppearance } from "../../lib/appearance";

/** One module row: label + px input. Edits apply live; the field normalizes on blur. */
function SizeRow({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));

  // Keep the field in sync when the store changes externally (e.g. reset).
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    onChange(parsed);
    setDraft(String(parsed));
  };

  return (
    <div className="appearance-row">
      <span>{label}</span>
      <div className="appearance-field">
        <Input
          type="number"
          min={APPEARANCE_MIN}
          max={APPEARANCE_MAX}
          step={1}
          value={draft}
          aria-label={`${label} font size`}
          onChange={(event) => {
            setDraft(event.target.value);
            // Live preview (the store clamps + rounds), without fighting the
            // user mid-typing — the field only snaps on blur/Enter.
            const parsed = Number(event.target.value);
            if (Number.isFinite(parsed)) onChange(parsed);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
          className="appearance-input"
        />
        <span className="appearance-unit">px</span>
      </div>
    </div>
  );
}

/**
 * Font tab: one base font size per module (sidebar, workspace, panels,
 * terminals). Everything in the app renders through the --fs-* tokens, so a
 * single number rescales a whole module — no more per-element px drift.
 */
export function FontSettings() {
  const { appearance, set, reset } = useAppearance();

  const uiRows: Array<[AppearanceKey, string]> = [
    ["sidebar", "Sidebar"],
    ["workspace", "Workspace"],
    ["models", "Models"],
    ["packages", "Packages"],
    ["git", "Git"],
    ["skills", "Skills"],
  ];

  return (
    <div className="appearance-section">
      <div className="appearance-group">
        <div className="appearance-group-title">UI</div>
        {uiRows.map(([key, label]) => (
          <SizeRow key={key} label={label} value={appearance[key]} onChange={(value) => set(key, value)} />
        ))}
      </div>
      <div className="appearance-group">
        <div className="appearance-group-title">Terminal</div>
        <SizeRow label="Pi TUI" value={appearance.termMain} onChange={(value) => set("termMain", value)} />
        <SizeRow label="Panel" value={appearance.termSide} onChange={(value) => set("termSide", value)} />
      </div>
      <div className="appearance-reset">
        <Button variant="outline" size="sm" onClick={reset}>
          Reset
        </Button>
      </div>
    </div>
  );
}
