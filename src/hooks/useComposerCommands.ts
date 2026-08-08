import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { CommandArgumentOption, CommandRecord, CommandSource, SkillRecord } from "../types/contracts";

const COMMAND_GROUPS: Array<{ label: string; sources: CommandSource[] }> = [
  { label: "System", sources: ["builtin"] },
  { label: "Extensions", sources: ["template", "plugin"] },
  { label: "Skills", sources: ["skill"] },
];

export type CommandPopupItem =
  | { kind: "command"; command: CommandRecord }
  | { kind: "argument"; option: CommandArgumentOption; command: string };

export interface CommandPopupGroup {
  source: string;
  label: string;
  items: CommandPopupItem[];
  start: number;
}

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
  const [argumentOptions, setArgumentOptions] = useState<CommandArgumentOption[]>([]);
  const [argumentLoading, setArgumentLoading] = useState(false);
  const popupListRef = useRef<HTMLDivElement>(null);
  const commandNameRef = useRef<string>("");

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

  // Any change to the line prefix (typing, or a programmatic accept that
  // inserts the completion) starts a fresh completion round: un-dismiss.
  useEffect(() => setPopupDismissed(false), [linePrefix]);

  /**
   * Argument mode: `/command <prefix>` on the current line. The first space
   * separates command from argument, so `/model cl` resolves to the "model"
   * command with prefix "cl". Memoized on a stable primitive so effect deps
   * stay simple.
   */
  const argumentMode = useMemo(() => {
    if (!linePrefix.startsWith("/") || !linePrefix.includes(" ") || linePrefix.includes("\t")) return null;
    const spaceIndex = linePrefix.indexOf(" ");
    return { command: linePrefix.slice(1, spaceIndex), prefix: linePrefix.slice(spaceIndex + 1) };
  }, [linePrefix]);

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

  // Client-side filter for the argument prefix.
  const filteredArguments = useMemo(() => {
    if (!argumentMode) return [];
    const query = argumentMode.prefix.toLowerCase();
    if (!query) return argumentOptions;
    return argumentOptions.filter(
      (option) =>
        option.value.toLowerCase().includes(query) ||
        option.label.toLowerCase().includes(query) ||
        (option.description ?? "").toLowerCase().includes(query),
    );
  }, [argumentOptions, argumentMode]);

  const argumentGroups = useMemo<CommandPopupGroup[]>(() => {
    if (!argumentMode || filteredArguments.length === 0) return [];
    const { command } = argumentMode;
    return [
      {
        source: "argument",
        label: `/${command}`,
        items: filteredArguments.map((option) => ({ kind: "argument" as const, option, command })),
        start: 0,
      },
    ];
  }, [filteredArguments, argumentMode]);
  const commandGroups = useMemo<CommandPopupGroup[]>(() => {
    let offset = 0;
    const groups: CommandPopupGroup[] = [];
    for (const { label, sources } of COMMAND_GROUPS) {
      const items = popupCommands
        .filter((command) => sources.includes(command.source))
        .map((command) => ({ kind: "command" as const, command }));
      if (items.length === 0) continue;
      groups.push({ source: sources[0]!, label, items, start: offset });
      offset += items.length;
    }
    return groups;
  }, [popupCommands]);

  const activeGroups = argumentMode ? argumentGroups : commandGroups;
  const activeItems = useMemo(() => activeGroups.flatMap((group) => group.items), [activeGroups]);
  // Keep the popup visible while argument completions are loading (shows the
  // "Loading…" row) and while options exist.
  const popupOpen =
    inputFocused && !popupDismissed && (activeItems.length > 0 || (argumentMode !== null && argumentLoading));
  const clampedIndex = activeItems.length === 0 ? 0 : Math.min(selectedIndex, activeItems.length - 1);

  // Load argument completions once per command; the prefix filters client-side.
  useEffect(() => {
    if (!argumentMode) {
      setArgumentOptions([]);
      setArgumentLoading(false);
      commandNameRef.current = "";
      return;
    }
    if (argumentMode.command === commandNameRef.current) return; // same command: options already loaded
    commandNameRef.current = argumentMode.command;
    let cancelled = false;
    setArgumentLoading(true);
    window.ePi.commands
      .argumentCompletions(cwd ?? "", argumentMode.command, "")
      .then((options) => {
        if (cancelled) return;
        setArgumentOptions(options ?? []);
        setArgumentLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setArgumentOptions([]);
        setArgumentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [argumentMode, cwd]);

  // Reset selection when switching between command/argument modes.
  useEffect(() => setSelectedIndex(0), [commandQuery, argumentMode?.command]);

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
    argumentLoading,
    activeItems,
    activeGroups,
    popupOpen,
    clampedIndex,
    popupAnchor,
    popupListRef,
    caret,
    setCaret,
    setInputFocused,
    dismissPopup: () => setPopupDismissed(true),
    setSelectedIndex,
    syncCaret,
  };
}
