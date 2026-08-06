import { Check, FolderOpen, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface CommonSettingsProps {
  /** Current default folder from the app info. */
  defaultCwd?: string;
  /** Called after the default folder was persisted successfully. */
  onChanged: () => void;
}

/**
 * General tab → "Common" group. Owns E-Pi-level settings that are not pi
 * agent options; the default folder saves on Enter/blur or via the picker.
 */
export function CommonSettings({ defaultCwd, onChanged }: CommonSettingsProps) {
  const [value, setValue] = useState(defaultCwd ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setValue(defaultCwd ?? "");
  }, [defaultCwd]);

  const flashSaved = () => {
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 2_000);
  };

  const save = async (next: string) => {
    const trimmed = next.trim();
    if (!trimmed || saving || trimmed === defaultCwd) return;
    setSaving(true);
    setError(undefined);
    try {
      await window.ePi.app.setDefaultCwd(trimmed);
      setValue(trimmed);
      flashSaved();
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const browse = async () => {
    const picked = await window.ePi.app.chooseDirectory(value || undefined);
    if (picked) void save(picked);
  };

  return (
    <section className="agent-section">
      <div className="agent-group-title">Common</div>
      {error ? (
        <div className="agent-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="common-row">
        <span className="common-row-label">Default folder</span>
        <div className="common-field">
          <Input
            className="common-input"
            value={value}
            aria-label="Default folder"
            placeholder={defaultCwd || "Home"}
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => void save(value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void save(value);
            }}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Browse for folder"
            title="Browse for folder"
            onClick={() => void browse()}
            disabled={saving}
          >
            <FolderOpen size={14} />
          </Button>
          {saving ? (
            <LoaderCircle className="spin common-save-indicator" size={14} />
          ) : saved ? (
            <Check className="common-save-indicator common-saved" size={14} />
          ) : null}
        </div>
      </div>
    </section>
  );
}
