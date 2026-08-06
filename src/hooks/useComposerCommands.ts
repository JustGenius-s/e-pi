import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { CommandRecord, CommandSource, SkillRecord } from "../types/contracts";

const COMMAND_GROUPS: Array<{ label: string; sources: CommandSource[] }> = [
  { label: "System", sources: ["builtin"] },
  { label: "Extensions", sources: ["template", "plugin"] },
  { label: "Skills", sources: ["skill"] },
];

interface UseComposerCommandsOptions {
  cwd?: string;
  text: string;
  skills: SkillRecord[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

export function useComposerCommands({ cwd, text, skills, textareaRef }: UseComposerCommandsOptions) {
  const [commands, setCommands] = useState<CommandRecord[]>([]);
  const [caret, setCaret] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [popupDismissed, setPopupDismissed] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [popupAnchor, setPopupAnchor] = useState<{ left: number; bottom: number; width: number }>();
  const popupListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCommands([]);
    if (!cwd) return;
    window.ePi.commands
      .list(cwd)
      .then(setCommands)
      .catch(() => setCommands([]));
  }, [cwd]);

  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const linePrefix = text.slice(lineStart, caret);
  const commandQuery = linePrefix.startsWith("/") && !linePrefix.includes(" ") ? linePrefix.slice(1) : null;

  const allCommands = useMemo(() => {
    const seen = new Set<string>();
    const result: CommandRecord[] = [];
    for (const command of commands) {
      if (seen.has(command.name)) continue;
      seen.add(command.name);
      result.push(command);
    }
    for (const skill of skills) {
      const name = `skill:${skill.name}`;
      if (seen.has(name)) continue;
      seen.add(name);
      result.push({ name, description: skill.description, source: "skill" });
    }
    return result;
  }, [commands, skills]);

  const popupCommands = useMemo(() => {
    if (commandQuery === null) return [];
    const query = commandQuery.toLowerCase();
    if (!query) return allCommands;
    const scored: Array<{ command: CommandRecord; score: number }> = [];
    for (const command of allCommands) {
      const name = command.name.toLowerCase();
      if (name.startsWith(query)) scored.push({ command, score: 0 });
      else if (name.includes(query)) scored.push({ command, score: 1 });
      else if ((command.description ?? "").toLowerCase().includes(query)) scored.push({ command, score: 2 });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map(({ command }) => command);
  }, [allCommands, commandQuery]);

  const commandGroups = useMemo(() => {
    let offset = 0;
    const groups: Array<{ source: CommandSource; label: string; items: CommandRecord[]; start: number }> = [];
    for (const { label, sources } of COMMAND_GROUPS) {
      const items = popupCommands.filter((command) => sources.includes(command.source));
      if (items.length === 0) continue;
      groups.push({ source: sources[0]!, label, items, start: offset });
      offset += items.length;
    }
    return groups;
  }, [popupCommands]);

  const popupOpen = inputFocused && commandQuery !== null && !popupDismissed && popupCommands.length > 0;
  const clampedIndex = popupCommands.length === 0 ? 0 : Math.min(selectedIndex, popupCommands.length - 1);

  useEffect(() => setSelectedIndex(0), [commandQuery]);

  useEffect(() => {
    if (!popupOpen) {
      setPopupAnchor(undefined);
      return;
    }
    const measure = () => {
      const element = textareaRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      setPopupAnchor({ left: rect.left + 8, bottom: window.innerHeight - rect.top, width: rect.width - 16 });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [popupOpen, text, textareaRef]);

  useEffect(() => {
    if (!popupOpen) return;
    popupListRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [clampedIndex, popupOpen, popupListRef]);

  const syncCaret = (element: HTMLTextAreaElement) => setCaret(element.selectionStart);

  return {
    commandGroups,
    filteredCommands: popupCommands,
    popupOpen,
    clampedIndex,
    popupAnchor,
    popupListRef,
    caret,
    setCaret,
    setInputFocused,
    setPopupDismissed,
    setSelectedIndex,
    syncCaret,
  };
}
