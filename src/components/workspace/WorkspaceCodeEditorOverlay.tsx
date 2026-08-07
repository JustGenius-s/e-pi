import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  selectAll,
  undo,
} from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchKeymap,
  setSearchQuery,
} from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type Panel,
} from "@codemirror/view";
import {
  AlertTriangle,
  Copy,
  Eye,
  FilePenLine,
  Loader2,
  MessageSquareText,
  Redo2,
  RefreshCw,
  Replace,
  Scissors,
  Search,
  TextSelect,
  Undo2,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import type { WorkspaceEditorOpenRequest, WorkspacePreviewOpenRequest } from "../../hooks/useWorkspaceOverlays";
import { emitInsertComposerText } from "../../lib/composerBus";
import { useEditorSettings } from "../../lib/editorSettings";
import { isFsError, toFsErrorMessage } from "../../lib/fsErrors";
import { languageForPath, languageLabel } from "../../lib/codeEditorLanguages";
import { formatCodeMentionToken } from "../../lib/mentionReferences";
import { cn } from "../../lib/utils";
import { isWorkspacePreviewPath } from "../../lib/workspacePreviewKind";
import { useIsDark } from "../../hooks/useIsDark";

import { autocompletion } from "@codemirror/autocomplete";

const EDITOR_ANIMATION_MS = 180;
const CONTEXT_MENU_WIDTH = 220;
const CONTEXT_MENU_HEIGHT = 340;

type EditorTabStatus = "ready" | "saving" | "conflict";

type EditorTab = {
  key: string;
  cwd: string;
  path: string;
  content: string;
  savedContent: string;
  mtimeMs: number;
  contentHash: string;
  totalLines: number;
  sizeBytes: number;
  status: EditorTabStatus;
  error: string | null;
  readOnly: boolean;
  /** Saved scroll position for tab switches. */
  scrollTop: number;
};

type PendingDialog = { kind: "closeOverlay" } | { kind: "closeTab"; tabKey: string } | { kind: "reloadTab"; tabKey: string };

type ContextMenuState = { x: number; y: number };

interface WorkspaceCodeEditorOverlayProps {
  openRequest: WorkspaceEditorOpenRequest | null;
  isOpen: boolean;
  /** Bump to request a real close (runs the dirty-save flow). */
  closeRequestId: number;
  onPreviewFile: (request: Omit<WorkspacePreviewOpenRequest, "id">) => void;
  /** Animation finished after a real close — drop state. */
  onClose: () => void;
}

function tabKey(cwd: string, path: string) {
  return `${cwd}\u0000${path}`;
}

function basename(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function dirname(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Debounced helper for search input → query updates. */
function debounce(fn: () => void, ms: number) {
  let timer: number | undefined;
  const wrapped = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(fn, ms);
  };
  wrapped.cancel = () => window.clearTimeout(timer);
  return wrapped;
}

/**
 * Custom find/replace panel for the CodeMirror search extension, styled to
 * match the app theme (light) and the editor theme (dark via the
 * `data-editor-theme` attribute on the overlay root). Replaces CM6's default
 * search panel UI entirely.
 */
function createSearchPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "workspace-find-bar";

  const findInput = document.createElement("input");
  findInput.className = "workspace-find-input";
  findInput.placeholder = "Find";
  findInput.setAttribute("main-field", "true");
  findInput.setAttribute("spellcheck", "false");

  const countEl = document.createElement("span");
  countEl.className = "workspace-find-count";

  let caseSensitive = false;
  let replaceOpen = false;

  const makeButton = (label: string, title: string, wide = false): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `workspace-find-btn${wide ? " wide" : ""}`;
    button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);
    return button;
  };

  const prevButton = makeButton("↑", "Previous match (Shift+Enter)");
  const nextButton = makeButton("↓", "Next match (Enter)");
  const caseButton = makeButton("Aa", "Match case");
  const toggleReplaceButton = makeButton("⇄", "Toggle replace");
  const closeButton = makeButton("✕", "Close (Esc)");

  const findRow = document.createElement("div");
  findRow.className = "workspace-find-row";
  findRow.append(findInput, countEl, prevButton, nextButton, caseButton, toggleReplaceButton, closeButton);
  dom.appendChild(findRow);

  const replaceInput = document.createElement("input");
  replaceInput.className = "workspace-find-input";
  replaceInput.placeholder = "Replace";
  replaceInput.setAttribute("spellcheck", "false");
  const replaceOneButton = makeButton("Replace", "Replace next (Enter)", true);
  const replaceAllButton = makeButton("All", "Replace all", true);
  const replaceRow = document.createElement("div");
  replaceRow.className = "workspace-find-row workspace-find-replace-row";
  replaceRow.append(replaceInput, replaceOneButton, replaceAllButton);
  dom.appendChild(replaceRow);

  const applyQuery = () => {
    const query = new SearchQuery({
      search: findInput.value,
      caseSensitive,
      replace: replaceInput.value,
    });
    view.dispatch({ effects: setSearchQuery.of(query) });
    if (findInput.value) {
      view.focus();
      findNext(view);
    }
  };

  const debouncedQuery = debounce(applyQuery, 150);

  const updateCount = () => {
    const query = getSearchQuery(view.state);
    if (!query.search) {
      countEl.textContent = "";
      return;
    }
    const doc = view.state.doc;
    // Counting every match is linear; cap the doc size to keep typing snappy.
    if (doc.length > 500_000) {
      countEl.textContent = "…";
      return;
    }
    const haystack = query.caseSensitive ? doc.toString() : doc.toString().toLowerCase();
    const needle = query.caseSensitive ? query.search : query.search.toLowerCase();
    const head = view.state.selection.main.head;
    let total = 0;
    let current = 0;
    let index = 0;
    while ((index = haystack.indexOf(needle, index)) !== -1) {
      total += 1;
      if (current === 0 && index + needle.length >= head) current = total;
      index += Math.max(needle.length, 1);
    }
    countEl.textContent = total === 0 ? "0" : `${current || total}/${total}`;
  };

  const debouncedCount = debounce(updateCount, 100);

  findInput.addEventListener("input", () => {
    debouncedQuery();
    debouncedCount();
  });
  findInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        findPrevious(view);
      } else {
        findNext(view);
      }
      debouncedCount();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSearchPanel(view);
    }
  });

  prevButton.addEventListener("click", () => {
    view.focus();
    findPrevious(view);
    debouncedCount();
  });
  nextButton.addEventListener("click", () => {
    view.focus();
    findNext(view);
    debouncedCount();
  });

  caseButton.addEventListener("click", () => {
    caseSensitive = !caseSensitive;
    caseButton.classList.toggle("active", caseSensitive);
    applyQuery();
    debouncedCount();
  });

  toggleReplaceButton.addEventListener("click", () => {
    replaceOpen = !replaceOpen;
    dom.classList.toggle("replace-open", replaceOpen);
    if (replaceOpen) replaceInput.focus();
  });

  closeButton.addEventListener("click", () => closeSearchPanel(view));

  const runReplace = (all: boolean) => {
    if (!findInput.value) return;
    // The replace text travels inside the search query state.
    applyQuery();
    if (all) {
      replaceAll(view);
    } else {
      view.focus();
      replaceNext(view);
    }
    debouncedCount();
  };
  replaceInput.addEventListener("input", debouncedQuery);
  replaceInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runReplace(false);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSearchPanel(view);
    }
  });
  replaceOneButton.addEventListener("click", () => runReplace(false));
  replaceAllButton.addEventListener("click", () => runReplace(true));

  return {
    top: true,
    dom,
    update(update) {
      const queryChanged = update.transactions.some((t) =>
        t.effects.some((e) => e.is(setSearchQuery)),
      );
      if (!update.docChanged && !update.selectionSet && !queryChanged) return;
      const query = getSearchQuery(update.state);
      if (query.search !== findInput.value) findInput.value = query.search;
      if (query.caseSensitive !== caseSensitive) {
        caseSensitive = query.caseSensitive;
        caseButton.classList.toggle("active", caseSensitive);
      }
      if (findInput.value) debouncedCount();
    },
    destroy() {
      debouncedQuery.cancel();
      debouncedCount.cancel();
    },
  };
}

/**
 * Theme extensions for the editor compartment: syntax highlight style plus
 * the editor chrome (colors, font size). Dark mode uses a fixed VS Code-ish
 * palette so the code area stays readable even when the app theme differs;
 * light mode follows the app CSS variables.
 */
function buildEditorTheme(dark: boolean, fontSize: number): Extension[] {
  const highlight = dark ? oneDarkHighlightStyle : defaultHighlightStyle;
  const scroller = {
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", monospace',
  };
  const theme: { [selector: string]: Record<string, string> } = dark
    ? {
        "&": { height: "100%", fontSize: `${fontSize}px`, backgroundColor: "#1e1e1e", color: "#d4d4d4" },
        ".cm-scroller": scroller,
        ".cm-gutters": { backgroundColor: "#1e1e1e", color: "#858585", borderRight: "1px solid #2f2f2f" },
        ".cm-activeLine": { backgroundColor: "#2a2d2e" },
        ".cm-activeLineGutter": { backgroundColor: "#2a2d2e", color: "#c6c6c6" },
        ".cm-cursor": { borderLeftColor: "#aeafad" },
        ".cm-selectionBackground": { backgroundColor: "#264f78 !important" },
        "&.cm-focused .cm-selectionBackground": { backgroundColor: "#264f78 !important" },
        ".cm-searchMatch": { backgroundColor: "#613214" },
        ".cm-searchMatch-selected": { backgroundColor: "#6c3c19" },
        ".cm-panels": { backgroundColor: "#252526", color: "#d4d4d4", borderBottom: "1px solid #333333" },
      }
    : {
        "&": { height: "100%", fontSize: `${fontSize}px`, backgroundColor: "var(--background)", color: "var(--foreground)" },
        ".cm-scroller": scroller,
        ".cm-gutters": {
          backgroundColor: "var(--background-stronger, var(--background))",
          color: "var(--muted-foreground)",
          borderRight: "1px solid var(--border)",
        },
        ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--muted) 60%, transparent)" },
        ".cm-activeLineGutter": { backgroundColor: "color-mix(in oklch, var(--muted) 60%, transparent)" },
        ".cm-cursor": { borderLeftColor: "var(--foreground)" },
        ".cm-selectionBackground": {
          backgroundColor: "color-mix(in oklch, var(--primary) 20%, transparent) !important",
        },
        "&.cm-focused .cm-selectionBackground": {
          backgroundColor: "color-mix(in oklch, var(--primary) 25%, transparent) !important",
        },
        ".cm-searchMatch": { backgroundColor: "color-mix(in oklch, var(--primary) 25%, transparent)" },
        ".cm-searchMatch-selected": { backgroundColor: "color-mix(in oklch, var(--primary) 40%, transparent)" },
        ".cm-panels": { backgroundColor: "var(--background)", color: "var(--foreground)", borderBottom: "1px solid var(--border)" },
      };
  return [syntaxHighlighting(highlight, { fallback: true }), EditorView.theme(theme, { dark })];
}

function editorExtensions(
  readOnly: boolean,
  language: ReturnType<typeof languageForPath>,
  themeExtensions: Extension,
  extraExtensions: Extension[] = [],
) {
  const theme = Array.isArray(themeExtensions) ? themeExtensions : [themeExtensions];
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    autocompletion(),
    search({ top: true, createPanel: createSearchPanel }),
    highlightActiveLine(),
    keymap.of([indentWithTab, ...searchKeymap, ...historyKeymap, ...defaultKeymap]),
    ...(language ? [language] : []),
    ...(readOnly ? [EditorState.readOnly.of(true)] : []),
    ...theme,
    ...extraExtensions,
  ];
}

/**
 * Full-column code editor overlay (CodeMirror 6) with multi-file tabs,
 * versioned saves and stale-file conflict handling. Port of LiveAgent's
 * WorkspaceCodeEditorOverlay; mutually exclusive with the preview overlay.
 */
export const WorkspaceCodeEditorOverlay = memo(function WorkspaceCodeEditorOverlay({
  openRequest,
  isOpen,
  closeRequestId,
  onPreviewFile,
  onClose,
}: WorkspaceCodeEditorOverlayProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<EditorView | null>(null);
  const editorModelKeyRef = useRef("");
  const activeKeyRef = useRef("");
  const openRequestIdRef = useRef<number | null>(null);
  const closeRequestIdRef = useRef<number | null>(null);
  const openAnimationFrameRef = useRef<number | null>(null);
  const closeAnimationTimeoutRef = useRef<number | null>(null);
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeKey, setActiveKey] = useState("");
  const [openingPaths, setOpeningPaths] = useState<string[]>([]);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [pendingDialog, setPendingDialog] = useState<PendingDialog | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.key === activeKey) ?? tabs[0] ?? null,
    [activeKey, tabs],
  );
  const canPreviewActiveTab = Boolean(activeTab && isWorkspacePreviewPath(activeTab.path));
  const dirtyTabs = useMemo(() => tabs.filter((tab) => tab.content !== tab.savedContent), [tabs]);
  const hasDirtyTabs = dirtyTabs.length > 0;
  const isOpening = openingPaths.length > 0;

  // Document-change listener. It must be part of *every* EditorState: tab
  // switches rebuild the state via setState, so a listener registered only
  // at editor creation would silently stop firing and edits would never mark
  // tabs dirty. A single stable instance is reused across rebuilds.
  const docUpdateListenerRef = useRef<Extension | null>(null);
  if (docUpdateListenerRef.current === null) {
    docUpdateListenerRef.current = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      const key = editorModelKeyRef.current;
      if (!key) return;
      const value = update.state.doc.toString();
      const lineCount = update.state.doc.lines;
      setTabs((current) =>
        current.map((tab) =>
          tab.key === key ? { ...tab, content: value, totalLines: lineCount, error: null } : tab,
        ),
      );
    });
  }

  useEffect(() => {
    openAnimationFrameRef.current = window.requestAnimationFrame(() => {
      openAnimationFrameRef.current = null;
      setIsVisible(true);
    });
    return () => {
      if (openAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(openAnimationFrameRef.current);
      }
      if (closeAnimationTimeoutRef.current !== null) {
        window.clearTimeout(closeAnimationTimeoutRef.current);
      }
    };
  }, []);

  const cancelPendingClose = useCallback(() => {
    if (closeAnimationTimeoutRef.current === null) return;
    window.clearTimeout(closeAnimationTimeoutRef.current);
    closeAnimationTimeoutRef.current = null;
    setIsVisible(true);
  }, []);

  const finishClose = useCallback(() => {
    if (closeAnimationTimeoutRef.current !== null) {
      window.clearTimeout(closeAnimationTimeoutRef.current);
      closeAnimationTimeoutRef.current = null;
    }
    setIsVisible(false);
    closeAnimationTimeoutRef.current = window.setTimeout(() => {
      closeAnimationTimeoutRef.current = null;
      onClose();
    }, EDITOR_ANIMATION_MS);
  }, [onClose]);

  const updateTab = useCallback((tabKeyValue: string, updater: (tab: EditorTab) => EditorTab) => {
    setTabs((current) => current.map((tab) => (tab.key === tabKeyValue ? updater(tab) : tab)));
  }, []);

  const saveTab = useCallback(
    async (targetKey: string) => {
      const tab = tabs.find((item) => item.key === targetKey);
      if (!tab || tab.content === tab.savedContent || tab.status === "saving") return true;
      if (tab.status === "conflict") {
        setGlobalError(tab.error ?? "The file changed on disk. Reload or force-overwrite to continue.");
        return false;
      }
      const contentToSave = tab.content;
      updateTab(targetKey, (current) => ({ ...current, status: "saving", error: null }));
      try {
        const response = await window.ePi.fs.writeText(tab.cwd, tab.path, contentToSave, {
          mtimeMs: tab.mtimeMs,
          contentHash: tab.contentHash,
        });
        updateTab(targetKey, (current) => ({
          ...current,
          savedContent: contentToSave,
          mtimeMs: response.mtimeMs,
          contentHash: response.contentHash,
          totalLines: current.content === contentToSave ? response.totalLines : current.totalLines,
          sizeBytes: new TextEncoder().encode(current.content).length,
          status: "ready",
          error: null,
        }));
        setGlobalError(null);
        return true;
      } catch (error) {
        const conflict = isFsError(error, "STALE_FILE");
        const message = conflict
          ? "The file changed on disk since it was opened."
          : toFsErrorMessage(error, "Save failed");
        updateTab(targetKey, (current) => ({
          ...current,
          status: conflict ? "conflict" : "ready",
          error: message,
        }));
        setGlobalError(message);
        return false;
      }
    },
    [tabs, updateTab],
  );

  const readTab = useCallback(
    async (request: WorkspaceEditorOpenRequest) => {
      const key = tabKey(request.cwd, request.path);
      const existing = tabs.find((tab) => tab.key === key);
      if (existing) {
        setActiveKey(key);
        setGlobalError(null);
        return;
      }
      setOpeningPaths((current) => [...current.filter((item) => item !== request.path), request.path]);
      setGlobalError(null);
      try {
        const response = await window.ePi.fs.readEditableText(request.cwd, request.path);
        const nextTab: EditorTab = {
          key,
          cwd: request.cwd,
          path: request.path,
          content: response.content,
          savedContent: response.content,
          mtimeMs: response.mtimeMs,
          contentHash: response.contentHash,
          totalLines: response.totalLines,
          sizeBytes: response.sizeBytes,
          status: "ready",
          error: null,
          readOnly: response.binary,
          scrollTop: 0,
        };
        setTabs((current) => {
          if (current.some((tab) => tab.key === key)) return current;
          return [...current, nextTab];
        });
        setActiveKey(key);
      } catch (error) {
        setGlobalError(toFsErrorMessage(error, "Failed to open file"));
      } finally {
        setOpeningPaths((current) => current.filter((item) => item !== request.path));
      }
    },
    [tabs],
  );

  const reloadTab = useCallback(
    async (targetKey: string) => {
      const tab = tabs.find((item) => item.key === targetKey);
      if (!tab) return false;
      setOpeningPaths((current) => [...current.filter((item) => item !== tab.path), tab.path]);
      setGlobalError(null);
      try {
        const response = await window.ePi.fs.readEditableText(tab.cwd, tab.path);
        const editor = editorRef.current;
        if (editor && editorModelKeyRef.current === targetKey) {
          const currentDoc = editor.state.doc.toString();
          if (currentDoc !== response.content) {
            editor.dispatch({ changes: { from: 0, to: currentDoc.length, insert: response.content } });
          }
        }
        updateTab(targetKey, (current) => ({
          ...current,
          path: tab.path,
          content: response.content,
          savedContent: response.content,
          mtimeMs: response.mtimeMs,
          contentHash: response.contentHash,
          totalLines: response.totalLines,
          sizeBytes: response.sizeBytes,
          status: "ready",
          error: null,
          readOnly: response.binary,
        }));
        return true;
      } catch (error) {
        const message = toFsErrorMessage(error, "Reload failed");
        updateTab(targetKey, (current) => ({ ...current, error: message }));
        setGlobalError(message);
        return false;
      } finally {
        setOpeningPaths((current) => current.filter((item) => item !== tab.path));
      }
    },
    [tabs, updateTab],
  );

  const closeTabNow = useCallback((targetKey: string) => {
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.key === targetKey);
      if (index < 0) return current;
      const next = current.filter((tab) => tab.key !== targetKey);
      setActiveKey((currentActive) => {
        if (currentActive !== targetKey) return currentActive;
        return next[Math.min(index, next.length - 1)]?.key ?? "";
      });
      return next;
    });
  }, []);

  const requestCloseTab = useCallback(
    (targetKey: string) => {
      const tab = tabs.find((item) => item.key === targetKey);
      if (!tab) return;
      if (tab.content !== tab.savedContent) {
        setPendingDialog({ kind: "closeTab", tabKey: targetKey });
        return;
      }
      closeTabNow(targetKey);
    },
    [closeTabNow, tabs],
  );

  const requestReloadTab = useCallback(
    (targetKey: string) => {
      const tab = tabs.find((item) => item.key === targetKey);
      if (!tab) return;
      if (tab.status !== "conflict" && tab.content !== tab.savedContent) {
        setPendingDialog({ kind: "reloadTab", tabKey: targetKey });
        return;
      }
      void reloadTab(targetKey);
    },
    [reloadTab, tabs],
  );

  const requestCloseOverlay = useCallback(() => {
    if (hasDirtyTabs) {
      setPendingDialog({ kind: "closeOverlay" });
      return;
    }
    finishClose();
  }, [finishClose, hasDirtyTabs]);

  const discardDialogTarget = useCallback(() => {
    const dialog = pendingDialog;
    setPendingDialog(null);
    if (!dialog) return;
    if (dialog.kind === "closeOverlay") {
      finishClose();
      return;
    }
    if (dialog.kind === "closeTab") {
      closeTabNow(dialog.tabKey);
      return;
    }
    void reloadTab(dialog.tabKey);
  }, [closeTabNow, finishClose, pendingDialog, reloadTab]);

  const saveDialogTarget = useCallback(() => {
    const dialog = pendingDialog;
    if (!dialog) return;
    void (async () => {
      if (dialog.kind === "closeOverlay") {
        for (const tab of dirtyTabs) {
          const saved = await saveTab(tab.key);
          if (!saved) return;
        }
        setPendingDialog(null);
        finishClose();
        return;
      }
      const saved = await saveTab(dialog.tabKey);
      if (!saved) return;
      setPendingDialog(null);
      if (dialog.kind === "closeTab") {
        closeTabNow(dialog.tabKey);
      } else {
        void reloadTab(dialog.tabKey);
      }
    })();
  }, [closeTabNow, dirtyTabs, finishClose, pendingDialog, reloadTab, saveTab]);

  const showFind = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    openSearchPanel(editor);
  }, []);

  const runEditorCommand = useCallback((command: (target: EditorView) => boolean) => {
    setContextMenu(null);
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    command(editor);
  }, []);

  const runClipboardCommand = useCallback(
    async (command: "cut" | "copy") => {
      setContextMenu(null);
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      // CM6 handles the native clipboard events fired by execCommand.
      document.execCommand(command);
    },
    [],
  );

  const pasteIntoEditor = useCallback(async () => {
    setContextMenu(null);
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      editor.dispatch(editor.state.replaceSelection(text));
    } catch {
      // Fall back to the native paste path (fires the browser's paste event).
      document.execCommand("paste");
    }
  }, []);

  /** Expand the selection to whole lines and send it as a code reference. */
  const insertSelectionAsCodeMention = useCallback(() => {
    setContextMenu(null);
    const editor = editorRef.current;
    const tab = activeTab;
    if (!editor || !tab) return;
    const { from, to, empty } = editor.state.selection.main;
    if (empty) {
      const line = editor.state.doc.lineAt(from);
      emitInsertComposerText(formatCodeMentionToken({ path: tab.path, startLine: line.number, endLine: line.number }, tab.cwd));
      return;
    }
    const startLine = editor.state.doc.lineAt(from).number;
    const endLineAt = editor.state.doc.lineAt(to);
    let endLine = endLineAt.number;
    // A selection ending at column 1 stops visually at the previous line.
    if (endLineAt.from === to) endLine = Math.max(startLine, endLine - 1);
    emitInsertComposerText(formatCodeMentionToken({ path: tab.path, startLine, endLine }, tab.cwd));
  }, [activeTab]);

  const openEditorContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!activeTab || pendingDialog) return;
      event.preventDefault();
      event.stopPropagation();
      editorRef.current?.focus();
      const rect = overlayRef.current?.getBoundingClientRect();
      if (!rect) return;
      const maxX = Math.max(8, rect.width - CONTEXT_MENU_WIDTH - 8);
      const maxY = Math.max(8, rect.height - CONTEXT_MENU_HEIGHT - 8);
      setContextMenu({
        x: Math.min(Math.max(event.clientX - rect.left, 8), maxX),
        y: Math.min(Math.max(event.clientY - rect.top, 8), maxY),
      });
    },
    [activeTab, pendingDialog],
  );

  useEffect(() => {
    if (!openRequest || openRequestIdRef.current === openRequest.id) return;
    openRequestIdRef.current = openRequest.id;
    cancelPendingClose();
    setIsVisible(true);
    void readTab(openRequest);
  }, [cancelPendingClose, openRequest, readTab]);

  useEffect(() => {
    if (isOpen) {
      if (closeAnimationTimeoutRef.current !== null) {
        window.clearTimeout(closeAnimationTimeoutRef.current);
        closeAnimationTimeoutRef.current = null;
      }
      const frame = window.requestAnimationFrame(() => setIsVisible(true));
      return () => window.cancelAnimationFrame(frame);
    }
    setIsVisible(false);
  }, [isOpen]);

  useEffect(() => {
    if (closeRequestId == null) return;
    if (closeRequestIdRef.current == null) {
      closeRequestIdRef.current = closeRequestId;
      return;
    }
    if (closeRequestIdRef.current === closeRequestId) return;
    closeRequestIdRef.current = closeRequestId;
    requestCloseOverlay();
  }, [closeRequestId, requestCloseOverlay]);

  useEffect(() => {
    activeKeyRef.current = activeTab?.key ?? "";
  }, [activeTab?.key]);

  // Editor settings → resolved code theme (light/dark).
  const { settings } = useEditorSettings();
  const appDark = useIsDark();
  const resolvedDark = settings.theme === "system" ? appDark : settings.theme === "dark";
  const themeCompartmentRef = useRef(new Compartment());
  const themeConfigRef = useRef<Extension[]>(buildEditorTheme(resolvedDark, settings.fontSize));
  themeConfigRef.current = buildEditorTheme(resolvedDark, settings.fontSize);

  // Live theme/font reconfiguration without losing document or undo history.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.dispatch({
      effects: themeCompartmentRef.current.reconfigure(themeConfigRef.current),
    });
  }, [resolvedDark, settings.fontSize]);

  // Drive the find-bar dark styling from the resolved editor theme.
  useEffect(() => {
    overlayRef.current?.setAttribute("data-editor-theme", resolvedDark ? "dark" : "light");
  }, [resolvedDark]);

  // Editor lifecycle: create once, bind/unbind models per active tab.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || editorRef.current) return;
    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: "",
        extensions: editorExtensions(
          true,
          null,
          themeCompartmentRef.current.of(themeConfigRef.current),
          [docUpdateListenerRef.current ?? []],
        ),
      }),
    });
    editorRef.current = view;
    return () => {
      view.destroy();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !activeTab) {
      if (editor) {
        editor.setState(
          EditorState.create({
            doc: "",
            extensions: editorExtensions(true, null, themeCompartmentRef.current.of(themeConfigRef.current), [
              docUpdateListenerRef.current ?? [],
            ]),
          }),
        );
        editorModelKeyRef.current = "";
      }
      return;
    }
    const previousKey = editorModelKeyRef.current;
    if (previousKey && previousKey !== activeTab.key) {
      // Preserve scroll position per tab.
      activeKeyRef.current = previousKey;
      updateTab(previousKey, (current) => ({ ...current, scrollTop: editor.scrollDOM.scrollTop }));
    }
    if (previousKey !== activeTab.key) {
      const language = languageForPath(activeTab.path);
      const extensions = editorExtensions(
        activeTab.readOnly,
        language,
        themeCompartmentRef.current.of(themeConfigRef.current),
        [docUpdateListenerRef.current ?? []],
      );
      editor.setState(
        EditorState.create({
          doc: activeTab.content,
          extensions,
        }),
      );
      editorModelKeyRef.current = activeTab.key;
      editor.scrollDOM.scrollTop = activeTab.scrollTop;
      editor.focus();
    } else if (editor.state.doc.toString() !== activeTab.content && !editor.state.readOnly) {
      // External reload while the same tab is active.
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: activeTab.content },
      });
    }
  }, [activeTab, updateTab]);

  // Reveal-and-select the requested line range from an open request.
  const activeTabKey = activeTab?.key;
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !activeTabKey || !openRequest?.line) return;
    if (activeTabKey !== tabKey(openRequest.cwd, openRequest.path)) return;
    const doc = editor.state.doc;
    const line = Math.min(Math.max(1, openRequest.line), doc.lines);
    const endLine = Math.min(Math.max(line, openRequest.endLine ?? line), doc.lines);
    const from = doc.line(line).from;
    const to = endLine === line ? doc.line(line).to : doc.line(endLine).to;
    editor.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    editor.focus();
  }, [activeTabKey, openRequest]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
      if (!isOpen) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      const currentKey = activeKeyRef.current;
      if (!currentKey) return;
      event.preventDefault();
      void saveTab(currentKey);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, saveTab]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeContextMenu = () => setContextMenu(null);
    window.addEventListener("click", closeContextMenu);
    window.addEventListener("blur", closeContextMenu);
    window.addEventListener("resize", closeContextMenu);
    return () => {
      window.removeEventListener("click", closeContextMenu);
      window.removeEventListener("blur", closeContextMenu);
      window.removeEventListener("resize", closeContextMenu);
    };
  }, [contextMenu]);

  const dialogTitle =
    pendingDialog?.kind === "closeOverlay"
      ? "Close editor with unsaved changes?"
      : pendingDialog?.kind === "reloadTab"
        ? "Reload from disk?"
        : "Close file with unsaved changes?";
  const dialogDescription =
    pendingDialog?.kind === "closeOverlay"
      ? `${dirtyTabs.length} file(s) have unsaved changes. Save them before closing?`
      : pendingDialog?.kind === "reloadTab"
        ? "Reloading from disk discards your unsaved changes."
        : "This file has unsaved changes. Save them before closing?";

  return (
    <div
      ref={overlayRef}
      className={cn("workspace-code-editor-overlay", isVisible ? "visible" : "hidden")}
    >
      <div className="workspace-overlay-toolbar">
        <FilePenLine className="workspace-overlay-toolbar-icon" />
        <div className="workspace-overlay-toolbar-titles">
          <div className="workspace-overlay-toolbar-title">File editor</div>
          <div className="workspace-overlay-toolbar-path">{activeTab ? activeTab.path : ""}</div>
        </div>
        <div className="workspace-overlay-toolbar-actions">
          <ToolbarButton label="Find" disabled={!activeTab} onClick={showFind}>
            <Search size={15} />
          </ToolbarButton>
          <ToolbarButton
            label="Reload from disk"
            disabled={!activeTab || isOpening}
            onClick={() => activeTab && requestReloadTab(activeTab.key)}
          >
            <RefreshCw size={15} className={isOpening ? "spin" : undefined} />
          </ToolbarButton>
          {canPreviewActiveTab && activeTab ? (
            <ToolbarButton
              label="Preview"
              onClick={() =>
                onPreviewFile({
                  cwd: activeTab.cwd,
                  path: activeTab.path,
                })
              }
            >
              <Eye size={15} />
            </ToolbarButton>
          ) : null}
          <ToolbarButton label="Close" onClick={requestCloseOverlay}>
            <X size={15} />
          </ToolbarButton>
        </div>
      </div>

      <div className="workspace-editor-tabs">
        {tabs.map((tab) => {
          const dirty = tab.content !== tab.savedContent;
          return (
            <div
              key={tab.key}
              className={cn(
                "workspace-editor-tab",
                tab.key === activeKey && "active",
                dirty && "dirty",
              )}
              title={tab.path}
            >
              <button
                type="button"
                className="workspace-editor-tab-main"
                onClick={() => setActiveKey(tab.key)}
              >
                {tab.status === "conflict" ? (
                  <AlertTriangle size={12} className="text-amber-500" />
                ) : (
                  <FilePenLine size={12} />
                )}
                <span className="truncate">{basename(tab.path)}</span>
              </button>
              <button
                type="button"
                className="workspace-editor-tab-close"
                title={dirty ? "Close (unsaved changes)" : "Close file"}
                aria-label="Close file"
                onClick={(event) => {
                  event.stopPropagation();
                  requestCloseTab(tab.key);
                }}
              >
                <span className="workspace-editor-tab-dirty-dot" />
                <X size={11} className="workspace-editor-tab-close-icon" />
              </button>
            </div>
          );
        })}
      </div>

      {globalError || activeTab?.error ? (
        <div className="workspace-overlay-error amber">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{activeTab?.error ?? globalError}</span>
          {activeTab?.status === "conflict" ? (
            <button
              type="button"
              className="workspace-overlay-error-action"
              onClick={() => requestReloadTab(activeTab.key)}
            >
              Reload from disk
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="workspace-editor-main" onContextMenu={openEditorContextMenu}>
        <div ref={containerRef} className={cn("absolute inset-0", !activeTab && "hidden")} />
        {!activeTab ? (
          <div className="workspace-preview-empty">
            {isOpening ? (
              <Loader2 size={22} className="spin" />
            ) : (
              <FilePenLine size={24} />
            )}
            <span>{isOpening ? "Opening…" : "Select a file from the file tree to edit"}</span>
            {globalError ? <span className="workspace-editor-empty-error">{globalError}</span> : null}
          </div>
        ) : null}
      </div>

      {contextMenu ? (
        <div
          className="workspace-editor-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
        >
          <ContextMenuItem icon={<Undo2 size={14} />} label="Undo" shortcut="⌘Z" onClick={() => runEditorCommand(undo)} />
          <ContextMenuItem icon={<Redo2 size={14} />} label="Redo" shortcut="⌘⇧Z" onClick={() => runEditorCommand(redo)} />
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={<Scissors size={14} />}
            label="Cut"
            shortcut="⌘X"
            onClick={() => void runClipboardCommand("cut")}
          />
          <ContextMenuItem
            icon={<Copy size={14} />}
            label="Copy"
            shortcut="⌘C"
            onClick={() => void runClipboardCommand("copy")}
          />
          <ContextMenuItem
            icon={<MessageSquareText size={14} />}
            label="Paste"
            shortcut="⌘V"
            onClick={() => void pasteIntoEditor()}
          />
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={<TextSelect size={14} />}
            label="Select all"
            shortcut="⌘A"
            onClick={() => runEditorCommand(selectAll)}
          />
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={<MessageSquareText size={14} />}
            label="Add selection to chat"
            onClick={insertSelectionAsCodeMention}
          />
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={<Search size={14} />}
            label="Find"
            shortcut="⌘F"
            onClick={() => {
              setContextMenu(null);
              showFind();
            }}
          />
          <ContextMenuItem
            icon={<Replace size={14} />}
            label="Replace"
            shortcut="⌘⌥F"
            onClick={() => {
              setContextMenu(null);
              const editor = editorRef.current;
              if (!editor) return;
              editor.focus();
              openSearchPanel(editor);
            }}
          />
        </div>
      ) : null}

      <div className="workspace-overlay-statusbar">
        <span className="truncate">{activeTab ? dirname(activeTab.path) || "/" : ""}</span>
        <span className="ml-auto shrink-0">
          {activeTab
            ? `${languageLabel(activeTab.path)} · ${activeTab.totalLines} lines · ${formatBytes(activeTab.sizeBytes)}${activeTab.readOnly ? " · read-only" : ""}`
            : ""}
        </span>
        {activeTab?.content !== activeTab?.savedContent ? (
          <span className="shrink-0 text-[var(--primary)]">● unsaved</span>
        ) : null}
      </div>

      {pendingDialog ? (
        <div className="workspace-overlay-dialog-backdrop">
          <div className="workspace-overlay-dialog">
            <div className="text-sm font-semibold">{dialogTitle}</div>
            <div className="mt-2 text-sm leading-5 text-[var(--muted-foreground)]">{dialogDescription}</div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="workspace-overlay-dialog-button"
                onClick={() => setPendingDialog(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="workspace-overlay-dialog-button"
                onClick={discardDialogTarget}
              >
                Discard
              </button>
              <button
                type="button"
                className="workspace-overlay-dialog-button primary"
                onClick={saveDialogTarget}
              >
                {pendingDialog.kind === "closeOverlay" ? "Save all" : "Save"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
});

function ToolbarButton(props: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const { label, disabled, onClick, children } = props;
  return (
    <button
      type="button"
      className="workspace-overlay-tool-button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ContextMenuItem(props: {
  icon?: ReactNode;
  label: string;
  shortcut?: string;
  onClick: () => void;
}) {
  const { icon, label, shortcut, onClick } = props;
  return (
    <button type="button" role="menuitem" className="workspace-editor-context-item" onClick={onClick}>
      {icon ? <span className="workspace-editor-context-icon">{icon}</span> : <span className="workspace-editor-context-icon" />}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {shortcut ? <kbd className="workspace-editor-context-kbd">{shortcut}</kbd> : null}
    </button>
  );
}

function ContextMenuSeparator() {
  return <hr className="workspace-editor-context-separator" />;
}
