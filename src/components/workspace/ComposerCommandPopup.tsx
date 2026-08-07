import { createPortal } from "react-dom";

import type { CommandPopupGroup, CommandPopupItem } from "../../hooks/useComposerCommands";

interface ComposerCommandPopupProps {
  groups: CommandPopupGroup[];
  selectedIndex: number;
  anchor?: { left: number; bottom: number; width: number };
  listRef: React.RefObject<HTMLDivElement | null>;
  /** Argument-mode loading state: shows a subtle spinner row. */
  loading?: boolean;
  onAccept: (item: CommandPopupItem) => void;
}

export function ComposerCommandPopup({
  groups,
  selectedIndex,
  anchor,
  listRef,
  loading,
  onAccept,
}: ComposerCommandPopupProps) {
  if (!anchor || (groups.length === 0 && !loading)) return null;
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
            {group.items.map((item, localIndex) => {
              const index = group.start + localIndex;
              const selected = index === selectedIndex;
              return (
                <button
                  key={item.kind === "command" ? `${item.command.source}:${item.command.name}` : `arg:${item.command}:${item.option.value}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-selected={selected ? "true" : undefined}
                  className="composer-command-row"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onAccept(item);
                  }}
                >
                  {item.kind === "command" ? (
                    <>
                      <span className="composer-command-name">/{item.command.name}</span>
                      {item.command.argumentHint ? <span className="composer-command-hint">{item.command.argumentHint}</span> : null}
                      {item.command.description ? <span className="composer-command-desc">{item.command.description}</span> : null}
                    </>
                  ) : (
                    <>
                      <span className="composer-command-name composer-command-arg-name">{item.option.label}</span>
                      {item.option.description ? <span className="composer-command-desc">{item.option.description}</span> : null}
                    </>
                  )}
                </button>
              );
            })}
          </div>
        ))}
        {loading ? (
          <div className="composer-command-group" role="status">
            <div className="composer-command-group-header">Loading…</div>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
