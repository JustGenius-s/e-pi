import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  EDITOR_FONT_MAX,
  EDITOR_FONT_MIN,
  type EditorThemeChoice,
  useEditorSettings,
} from "../../lib/editorSettings";

const THEME_OPTIONS: Array<{ value: EditorThemeChoice; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * Editor tab: code font size + code theme for the built-in CodeMirror
 * editor. Changes apply live to open editor tabs.
 */
export function EditorSettings() {
  const { settings, setFontSize, setTheme } = useEditorSettings();
  const [draft, setDraft] = useState(String(settings.fontSize));

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(settings.fontSize));
      return;
    }
    setFontSize(parsed);
    setDraft(String(settings.fontSize));
  };

  return (
    <div className="appearance-section">
      <div className="appearance-group">
        <div className="appearance-group-title">Code Editor</div>
        <div className="appearance-row">
          <span>Font size</span>
          <div className="appearance-field">
            <Input
              type="number"
              min={EDITOR_FONT_MIN}
              max={EDITOR_FONT_MAX}
              step={1}
              value={draft}
              aria-label="Editor font size"
              onChange={(event) => {
                setDraft(event.target.value);
                // Live preview (the store clamps + rounds), without fighting
                // the user mid-typing — the field snaps on blur/Enter.
                const parsed = Number(event.target.value);
                if (Number.isFinite(parsed)) setFontSize(parsed);
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
        <div className="appearance-row">
          <span>Theme</span>
          <div className="editor-theme-segment" role="radiogroup" aria-label="Editor theme">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={settings.theme === option.value}
                className={`editor-theme-segment-item${settings.theme === option.value ? " active" : ""}`}
                onClick={() => setTheme(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="appearance-row">
          <span className="appearance-note">
            Theme applies to the code area only; “System” follows the app theme. Changes apply instantly to open
            files.
          </span>
        </div>
      </div>
      <div className="appearance-reset">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setFontSize(13);
            setTheme("system");
            setDraft("13");
          }}
        >
          Reset
        </Button>
      </div>
    </div>
  );
}
