import { useCallback, useEffect, useRef, useState } from "react";

import type { PiNavEntry, PiViewportState } from "../../lib/terminalViewportProtocol";

export interface MessageNavigatorProps {
  entries: PiNavEntry[];
  viewport: PiViewportState | undefined;
  onJump: (row: number) => void;
}

/**
 * ChatGPT-style session navigator. The rail sits vertically centered on the
 * transcript's left edge and the bars are always clustered in the middle of
 * the rail (they do NOT spread by transcript position). The bar whose message
 * is at the viewport top is highlighted; hovering elongates the bar under the
 * pointer with a stepped gradient on its neighbors and shows only that
 * message's title beside it. Clicking jumps the viewport to the message.
 */
export function MessageNavigator({ entries, viewport, onJump }: MessageNavigatorProps) {
  const [hoveredRow, setHoveredRow] = useState<number>();
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const railRef = useRef<HTMLDivElement>(null);
  const [tickTops, setTickTops] = useState<number[]>([]);

  const clearLeave = useCallback(() => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = undefined;
  }, []);
  const scheduleLeave = useCallback(() => {
    clearLeave();
    leaveTimer.current = setTimeout(() => setHoveredRow(undefined), 90);
  }, [clearLeave]);
  useEffect(() => () => clearLeave(), [clearLeave]);

  // Measure each bar's vertical center inside the rail so the tooltip can
  // track the hovered bar (bars are flex-stacked, so their offset depends on
  // clipping when the transcript has many messages).
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const measure = () => {
      const navRect = rail.parentElement?.getBoundingClientRect();
      if (!navRect) return;
      const tops = Array.from(rail.querySelectorAll<HTMLElement>(".message-nav-tick")).map(
        (el) => el.getBoundingClientRect().top + el.offsetHeight / 2 - navRect.top,
      );
      setTickTops(tops);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [entries.length]);

  if (entries.length === 0 || !viewport) return null;

  const { scrollTop } = viewport;

  // Active message = last entry whose offset is at/above the viewport top.
  let activeRow = 1;
  for (const entry of entries) {
    if (entry.offset <= scrollTop + 1) activeRow = entry.row;
    else break;
  }

  const hoveredEntry = hoveredRow === undefined ? undefined : entries.find((e) => e.row === hoveredRow);
  const hoveredIndex = hoveredEntry ? entries.findIndex((e) => e.row === hoveredEntry.row) : -1;

  return (
    <div className="message-nav" onMouseLeave={scheduleLeave}>
      <div className="message-nav-rail" role="navigation" aria-label="User messages" ref={railRef}>
        {entries.map((entry) => {
          // Stepped elongation around the hovered bar: 0 → longest, ±1 → mid, ±2 → slight.
          const distance = hoveredRow === undefined ? undefined : Math.abs(entry.row - hoveredRow);
          const level = distance === undefined ? 0 : distance === 0 ? 3 : distance === 1 ? 2 : distance === 2 ? 1 : 0;
          return (
            <button
              key={entry.row}
              type="button"
              className="message-nav-tick"
              data-active={entry.row === activeRow}
              data-level={level}
              onMouseEnter={() => {
                clearLeave();
                setHoveredRow(entry.row);
              }}
              onClick={() => onJump(entry.row)}
              aria-label={`Jump to message ${entry.row}: ${entry.label}`}
            />
          );
        })}
      </div>
      {hoveredEntry && (
        <div
          className="message-nav-tip"
          style={{
            top:
              tickTops[hoveredIndex] !== undefined
                ? `${Math.min(Math.max(tickTops[hoveredIndex], 16), (railRef.current?.parentElement?.offsetHeight ?? 400) - 16)}px`
                : "50%",
          }}
        >
          <div className="message-nav-tip-title">{hoveredEntry.label || `Message ${hoveredEntry.row}`}</div>
          {hoveredEntry.reply && <div className="message-nav-tip-reply">{hoveredEntry.reply}</div>}
        </div>
      )}
    </div>
  );
}
