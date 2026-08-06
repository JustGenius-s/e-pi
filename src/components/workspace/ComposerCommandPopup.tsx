import { createPortal } from "react-dom";

import type { CommandRecord, CommandSource } from "../../types/contracts";

interface ComposerCommandPopupProps {
  commands: CommandRecord[];
  groups: Array<{ source: CommandSource; label: string; items: CommandRecord[]; start: number }>;
  selectedIndex: number;
  anchor?: { left: number; bottom: number; width: number };
  listRef: React.RefObject<HTMLDivElement | null>;
  onAccept: (command: CommandRecord) => void;
}

export function ComposerCommandPopup({
  commands,
  groups,
  selectedIndex,
  anchor,
  listRef,
  onAccept,
}: ComposerCommandPopupProps) {
  if (!anchor || commands.length === 0) return null;
  return createPortal(
    <div
      className="composer-command-popup"
      style={{ left: anchor.left, bottom: anchor.bottom, width: anchor.width }}
      role="listbox"
      aria-label="Commands"
    >
      <div className="composer-command-list" ref={listRef}>
        {groups.map((group) => (
          <div className="composer-command-group" role="group" aria-label={group.label} key={group.source}>
            <div className="composer-command-group-header">{group.label}</div>
            {group.items.map((command, localIndex) => {
              const index = group.start + localIndex;
              const selected = index === selectedIndex;
              return (
                <button
                  key={`${command.source}:${command.name}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-selected={selected ? "true" : undefined}
                  className="composer-command-row"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onAccept(command);
                  }}
                >
                  <span className="composer-command-name">/{command.name}</span>
                  {command.argumentHint ? <span className="composer-command-hint">{command.argumentHint}</span> : null}
                  {command.description ? <span className="composer-command-desc">{command.description}</span> : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
