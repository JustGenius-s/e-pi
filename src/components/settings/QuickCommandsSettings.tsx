import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import { useQuickCommands } from "../../hooks/useQuickCommands";
import {
  clampCommandName,
  QUICK_COMMANDS_MAX,
  QUICK_COMMAND_NAME_MAX,
  updateQuickCommands,
  type QuickCommand,
} from "../../lib/quickCommands";

function createCommand(): QuickCommand {
  return { id: crypto.randomUUID(), name: "", prompt: "" };
}

/**
 * Settings → Composer: enable quick commands and edit up to QUICK_COMMANDS_MAX
 * of them. Every change persists immediately through the shared store, so the
 * composer's floating row updates live. Names are capped at 10 characters;
 * the composer only surfaces commands with a name and a prompt.
 */
export function QuickCommandsSettings() {
  const settings = useQuickCommands();
  const { enabled, commands } = settings;

  const setEnabled = (next: boolean) => updateQuickCommands({ ...settings, enabled: next });
  const updateCommand = (id: string, patch: Partial<Pick<QuickCommand, "name" | "prompt">>) =>
    updateQuickCommands({
      ...settings,
      commands: commands.map((command) => (command.id === id ? { ...command, ...patch } : command)),
    });
  const removeCommand = (id: string) =>
    updateQuickCommands({ ...settings, commands: commands.filter((command) => command.id !== id) });
  const addCommand = () => {
    if (commands.length >= QUICK_COMMANDS_MAX) return;
    updateQuickCommands({ ...settings, commands: [...commands, createCommand()] });
  };

  return (
    <section className="agent-section">
      <div className="agent-group-title">Quick commands</div>
      <p className="agent-description">
        One-click prompts shown floating above the input box while it is empty. Clicking a command sends its prompt
        directly.
      </p>
      <div className="common-row">
        <span className="common-row-label">Show quick commands</span>
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Show quick commands" />
      </div>
      <div className="quick-commands-list">
        {commands.map((command) => (
          <div key={command.id} className="quick-command-row">
            <Input
              className="quick-command-name"
              value={command.name}
              maxLength={QUICK_COMMAND_NAME_MAX}
              placeholder={`Name (max ${QUICK_COMMAND_NAME_MAX})`}
              aria-label="Command name"
              onChange={(event) => updateCommand(command.id, { name: clampCommandName(event.target.value) })}
            />
            <Textarea
              className="quick-command-prompt"
              rows={2}
              value={command.prompt}
              placeholder="Prompt sent on click"
              aria-label="Command prompt"
              onChange={(event) => updateCommand(command.id, { prompt: event.target.value })}
            />
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Remove command"
              title="Remove command"
              onClick={() => removeCommand(command.id)}
            >
              <Trash2 size={13} />
            </Button>
          </div>
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="quick-commands-add"
        onClick={addCommand}
        disabled={commands.length >= QUICK_COMMANDS_MAX}
      >
        <Plus size={13} />
        <span>
          Add command ({commands.length}/{QUICK_COMMANDS_MAX})
        </span>
      </Button>
    </section>
  );
}
