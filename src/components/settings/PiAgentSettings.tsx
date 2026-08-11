import { Check, Download, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import type { AgentThinkingLevel, PiAgentConfig, PiTuiSettings, PiUpdateInfo } from "../../types/contracts";

const PI_COMPATIBILITY_REQUIRED_PREFIX = "E_PI_TUI_COMPATIBILITY_REQUIRED:";

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
  /** Whether E-Pi's injectable TUI performance layer is active. */
  tuiOptimizationsEnabled?: boolean;
  /** Called after a pi update finished, so callers can refresh app info. */
  onUpdated?: () => void;
}

/**
 * General tab → "Pi Agent" group. These settings are stored in E-Pi's own
 * config and passed to pi as CLI args at session launch, so they only affect
 * sessions started from E-Pi (never `~/.pi` files or terminal usage).
 */
export function PiAgentSettings({
  active,
  piVersion,
  tuiOptimizationsEnabled = true,
  onUpdated,
}: PiAgentSettingsProps) {
  const [config, setConfig] = useState<PiAgentConfig>();
  const [tui, setTui] = useState<PiTuiSettings>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [update, setUpdate] = useState<PiUpdateInfo>();
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [stockFallbackVersion, setStockFallbackVersion] = useState<string>();
  const [togglingTuiOptimizations, setTogglingTuiOptimizations] = useState(false);
  const [tuiOptimizationValue, setTuiOptimizationValue] = useState(tuiOptimizationsEnabled);
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
    window.ePi.agent
      .getTuiSettings()
      .then((next) => {
        if (mounted) setTui(next);
      })
      .catch((reason: unknown) => {
        if (mounted) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      mounted = false;
    };
  }, [active]);

  useEffect(() => {
    setTuiOptimizationValue(tuiOptimizationsEnabled);
  }, [tuiOptimizationsEnabled]);

  const toggleTuiOptimizations = async (enabled: boolean) => {
    if (togglingTuiOptimizations) return;
    const previous = tuiOptimizationValue;
    setTuiOptimizationValue(enabled);
    setTogglingTuiOptimizations(true);
    setError(undefined);
    try {
      await window.ePi.app.setTuiOptimizationsEnabled(enabled);
      toast.success(enabled ? "TUI optimization patch loaded" : "Using stock pi-tui rendering");
      onUpdated?.();
    } catch (reason) {
      setTuiOptimizationValue(previous);
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      toast.error(`Failed to change TUI optimization mode: ${message}`);
    } finally {
      setTogglingTuiOptimizations(false);
    }
  };

  const patch = (partial: Partial<PiAgentConfig>) => {
    setConfig((current) => (current ? { ...current, ...partial } : current));
    setSaved(false);
  };

  const patchTui = (partial: Partial<PiTuiSettings>) => {
    setTui((current) => (current ? { ...current, ...partial } : current));
  };

  const saveTuiSettings = async (next: PiTuiSettings) => {
    try {
      setTui(await window.ePi.agent.saveTuiSettings({ settings: next }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
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

  const completeUpdate = (result: { from: string; to: string; fallbackToStock?: boolean }) => {
    setUpdate({ current: result.to, latest: undefined });
    if (result.fallbackToStock) {
      toast.success(
        `Pi updated from ${result.from} to ${result.to} with stock pi-tui. The optimization patch is disabled until compatibility is added.`,
      );
    } else {
      toast.success(`Pi updated from ${result.from} to ${result.to}`);
    }
    onUpdated?.();
  };

  const applyUpdate = async (allowStockFallback = false) => {
    if (updating) return;
    setUpdating(true);
    setError(undefined);
    try {
      const result = await window.ePi.app.applyPiUpdate({ allowStockFallback });
      setStockFallbackVersion(undefined);
      completeUpdate(result);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      const compatibilityAt = message.indexOf(PI_COMPATIBILITY_REQUIRED_PREFIX);
      if (!allowStockFallback && compatibilityAt >= 0) {
        const version = message.slice(compatibilityAt + PI_COMPATIBILITY_REQUIRED_PREFIX.length).split(":", 1)[0];
        setStockFallbackVersion(version || update?.latest);
      } else {
        setError(message);
        toast.error(`Failed to update Pi: ${message}`);
      }
    } finally {
      setUpdating(false);
    }
  };

  const installedPiVersion = update?.current ?? piVersion ?? "the currently installed version";
  const pendingPiVersion = stockFallbackVersion ?? update?.latest ?? "the new version";

  return (
    <section className="agent-section">
      <div className="agent-group-title">Pi Agent</div>

      {tui ? (
        <>
          <div className="agent-row">
            <div className="agent-row-label">
              <span>Load TUI optimization patch</span>
              <small>
                Smooth resize, scrolling, and streaming. An incompatible Pi update asks before falling back to stock
                pi-tui; the patch stays off until E-Pi adds compatibility.
              </small>
            </div>
            <Switch
              checked={tuiOptimizationValue}
              onCheckedChange={(checked) => void toggleTuiOptimizations(checked)}
              disabled={togglingTuiOptimizations}
              aria-label="Load TUI optimization patch"
            />
          </div>

          <div className="agent-row">
            <div className="agent-row-label">
              <span>Quiet startup</span>
              <small>Hide Pi&rsquo;s startup header. Applies to new sessions.</small>
            </div>
            <Switch
              checked={tui.quietStartup}
              onCheckedChange={(checked) => {
                const next = { ...tui, quietStartup: checked };
                patchTui({ quietStartup: checked });
                void saveTuiSettings(next);
              }}
              aria-label="Quiet startup"
            />
          </div>

          <div className="agent-row">
            <div className="agent-row-label">
              <span>Hide thinking blocks</span>
              <small>Collapse thinking output in the transcript. Applies to new sessions.</small>
            </div>
            <Switch
              checked={tui.hideThinkingBlock}
              onCheckedChange={(checked) => {
                const next = { ...tui, hideThinkingBlock: checked };
                patchTui({ hideThinkingBlock: checked });
                void saveTuiSettings(next);
              }}
              aria-label="Hide thinking blocks"
            />
          </div>
        </>
      ) : null}

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
              ) : update && !update.latest ? (
                <span className="agent-version-status">
                  <Check size={12} /> Up to date
                </span>
              ) : null}
              {checking || !update?.latest ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="agent-update-btn"
                  onClick={() => void checkUpdate()}
                  disabled={checking || updating}
                >
                  <RefreshCw size={13} />
                  {checking ? "Checking…" : "Check updates"}
                </Button>
              ) : null}
              {update?.latest ? (
                <Button
                  variant="default"
                  size="sm"
                  className="agent-update-btn"
                  onClick={() => void applyUpdate()}
                  disabled={updating}
                >
                  {updating ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />}
                  {updating ? "Updating…" : `Update to ${update.latest}`}
                </Button>
              ) : null}
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

      <AlertDialog
        open={stockFallbackVersion !== undefined}
        onOpenChange={(open) => !open && !updating && setStockFallbackVersion(undefined)}
      >
        <AlertDialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Pi {pendingPiVersion} needs stock TUI</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-left">
                <p>The TUI optimization patch is not compatible with this Pi version. Nothing has been changed yet.</p>

                <div className="border-t pt-3">
                  <p className="font-medium text-foreground">Keep Pi {installedPiVersion} (recommended)</p>
                  <p className="mt-1">
                    Cancel the update. Your current Pi, TUI optimizations, and running sessions stay unchanged.
                  </p>
                </div>

                <div className="border-t pt-3">
                  <p className="font-medium text-foreground">Update to Pi {pendingPiVersion}</p>
                  <p className="mt-1">
                    Use stock pi-tui. E-Pi disables the patch and restarts running sessions; conversation history is
                    kept. Optimizations remain unavailable until compatibility is added and the patch is re-enabled.
                  </p>
                </div>

                <p className="border-t pt-3 text-xs">If installation fails, E-Pi restores Pi {installedPiVersion}.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel variant="default" disabled={updating}>
              Keep Pi {installedPiVersion}
            </AlertDialogCancel>
            <AlertDialogAction variant="outline" disabled={updating} onClick={() => void applyUpdate(true)}>
              {updating ? <LoaderCircle className="spin" size={14} /> : null}
              Update and use stock TUI
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
