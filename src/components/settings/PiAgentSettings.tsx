import { Check, Download, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import type { AgentThinkingLevel, PiAgentConfig, PiUpdateInfo } from "../../types/contracts";

const THINKING_OPTIONS: Array<{ value: AgentThinkingLevel; label: string }> = [
  { value: "", label: "Not set" },
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "X-high" },
  { value: "max", label: "Max" },
];

interface PiAgentSettingsProps {
  /** Whether the settings dialog is open; reloads stored config when it becomes true. */
  active: boolean;
  /** Version of the bundled pi package, shown in the Pi version row. */
  piVersion?: string;
}

/**
 * General tab → "Pi Agent" group. These settings are stored in E-Pi's own
 * config and passed to pi as CLI args at session launch, so they only affect
 * sessions started from E-Pi (never `~/.pi` files or terminal usage).
 */
export function PiAgentSettings({ active, piVersion }: PiAgentSettingsProps) {
  const [config, setConfig] = useState<PiAgentConfig>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [update, setUpdate] = useState<PiUpdateInfo>();
  const [checking, setChecking] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!active) return;
    let mounted = true;
    setError(undefined);
    window.ePi.agent
      .getConfig()
      .then((next) => {
        if (mounted) {
          setConfig(next);
          setSaved(false);
        }
      })
      .catch((reason: unknown) => {
        if (mounted) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      mounted = false;
    };
  }, [active]);

  const patch = (partial: Partial<PiAgentConfig>) => {
    setConfig((current) => (current ? { ...current, ...partial } : current));
    setSaved(false);
  };

  const save = async () => {
    if (!config || saving) return;
    setSaving(true);
    setError(undefined);
    setSaved(false);
    try {
      const next = await window.ePi.agent.saveConfig({ config });
      setConfig(next);
      setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2_500);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const checkUpdate = async () => {
    if (checking) return;
    setChecking(true);
    setError(undefined);
    try {
      setUpdate(await window.ePi.app.checkPiUpdate());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setChecking(false);
    }
  };

  const updateLabel =
    update === undefined ? null : update.latest ? `Update available: ${update.latest}` : "Up to date";

  return (
    <section className="agent-section">
      <div className="agent-group-title">Pi Agent</div>

      {config ? (
        <>
          <div className="agent-row">
            <div className="agent-row-label">
              <span>Pi version</span>
            </div>
            <div className="agent-version">
              <code className="agent-version-code">{piVersion || "-"}</code>
              {checking ? (
                <span className="agent-version-status">
                  <LoaderCircle className="spin" size={12} /> Checking…
                </span>
              ) : updateLabel ? (
                <span className={`agent-version-status${update?.latest ? " outdated" : ""}`}>
                  {update?.latest ? <Download size={12} /> : <Check size={12} />}
                  {updateLabel}
                </span>
              ) : null}
              <Button variant="ghost" size="sm" className="agent-update-btn" onClick={() => void checkUpdate()} disabled={checking}>
                <RefreshCw size={13} />
                {checking ? "Checking…" : "Check updates"}
              </Button>
            </div>
          </div>

          <div className="agent-field">
            <label htmlFor="agent-system-prompt">System prompt (replace)</label>
            <Textarea
              id="agent-system-prompt"
              className="agent-textarea"
              value={config.systemPrompt}
              placeholder="Leave empty to use Pi's default system prompt"
              onChange={(event) => patch({ systemPrompt: event.target.value })}
            />
          </div>

          <div className="agent-field">
            <label htmlFor="agent-append-prompt">System prompt (append)</label>
            <Textarea
              id="agent-append-prompt"
              className="agent-textarea"
              value={config.appendSystemPrompt}
              placeholder="e.g. Always explain changes in one sentence and cite file paths."
              onChange={(event) => patch({ appendSystemPrompt: event.target.value })}
            />
          </div>

          <div className="agent-row">
            <div className="agent-row-label">
              <span>Default thinking level</span>
            </div>
            <Select
              value={config.thinkingLevel}
              onValueChange={(value) => patch({ thinkingLevel: value as AgentThinkingLevel })}
            >
              <SelectTrigger aria-label="Default thinking level" className="agent-select">
                <SelectValue placeholder="Not set" />
              </SelectTrigger>
              <SelectContent>
                {THINKING_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="agent-row">
            <div className="agent-row-label">
              <span>Context files</span>
            </div>
            <Switch
              checked={config.contextFiles}
              onCheckedChange={(checked) => patch({ contextFiles: checked })}
              aria-label="Load context files"
            />
          </div>

          {error ? (
            <div className="agent-error" role="alert">
              {error}
            </div>
          ) : null}

          <div className="agent-save">
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <LoaderCircle className="spin" size={16} /> : saved ? <Check size={16} /> : null}
              {saving ? "Saving…" : saved ? "Saved" : "Save"}
            </Button>
          </div>
        </>
      ) : error ? (
        <div className="agent-error" role="alert">
          {error}
        </div>
      ) : (
        <div className="agent-loading">
          <LoaderCircle className="spin" size={16} />
        </div>
      )}
    </section>
  );
}
