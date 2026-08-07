import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { StreamLanguage, type Language, type LanguageSupport } from "@codemirror/language";
import { cpp, java } from "@codemirror/legacy-modes/mode/clike";
import { go } from "@codemirror/legacy-modes/mode/go";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml as tomlMode } from "@codemirror/legacy-modes/mode/toml";

function basename(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

export type EditorLanguage = LanguageSupport | Language | null;

const languageCache = new Map<string, EditorLanguage>();

/** CM6 language for a workspace path, cached per resolved kind. */
export function languageForPath(path: string): EditorLanguage {
  const key = basename(path).toLowerCase();
  const cached = languageCache.get(key);
  if (cached !== undefined) return cached;

  let support: EditorLanguage = null;
  const name = key;
  if (name === "dockerfile") support = null;
  else if (name === "makefile") support = null;
  else if (name === "cargo.lock") support = StreamLanguage.define(tomlMode);
  else if (name.endsWith(".d.ts")) support = javascript({ typescript: true });

  if (!support) {
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
    switch (ext) {
      case "js":
      case "jsx":
      case "mjs":
      case "cjs":
        support = javascript();
        break;
      case "ts":
      case "tsx":
        support = javascript({ typescript: true });
        break;
      case "json":
      case "jsonc":
        support = json();
        break;
      case "css":
      case "scss":
      case "sass":
      case "less":
        support = css();
        break;
      case "html":
      case "htm":
        support = html();
        break;
      case "md":
      case "mdx":
        support = markdown();
        break;
      case "rs":
        support = StreamLanguage.define(rust);
        break;
      case "go":
        support = StreamLanguage.define(go);
        break;
      case "py":
        support = python();
        break;
      case "java":
        support = StreamLanguage.define(java);
        break;
      case "kt":
      case "kts":
        support = StreamLanguage.define(java);
        break;
      case "c":
      case "h":
      case "cc":
      case "cpp":
      case "cxx":
      case "hpp":
        support = StreamLanguage.define(cpp);
        break;
      case "cs":
        support = StreamLanguage.define(cpp);
        break;
      case "sh":
      case "bash":
      case "zsh":
        support = StreamLanguage.define(shell);
        break;
      case "yml":
      case "yaml":
        support = yaml();
        break;
      case "toml":
        support = StreamLanguage.define(tomlMode);
        break;
      case "xml":
      case "svg":
        support = xml();
        break;
      case "sql":
        support = sql();
        break;
      default:
        support = null;
        break;
    }
  }
  languageCache.set(key, support);
  return support;
}

/** Human-readable language label for the status bar. */
export function languageLabel(path: string): string {
  const name = basename(path).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const LABELS: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    json: "json",
    jsonc: "json",
    css: "css",
    scss: "scss",
    html: "html",
    md: "markdown",
    mdx: "markdown",
    rs: "rust",
    go: "go",
    py: "python",
    java: "java",
    kt: "kotlin",
    c: "c",
    h: "c",
    cpp: "cpp",
    cs: "csharp",
    sh: "shell",
    bash: "shell",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    xml: "xml",
    sql: "sql",
  };
  return LABELS[ext] ?? "plaintext";
}
