import { preloadHighlighter } from "@pierre/diffs";

/**
 * Languages the diff viewer is likely to encounter, warmed into the shared
 * Shiki highlighter up front. @pierre/diffs lazy-loads the highlighter
 * (theme + language grammars) on its first render, which paints nothing
 * until the async load finishes — that's why the first file expansion after
 * app start looks empty while the second one (cache now warm) works. Names
 * are the format names `getFiletypeFromFileName` maps extensions to, so
 * every entry is a valid bundled Shiki language; anything not listed here
 * still lazy-loads on demand, covered by DiffView's loading placeholder.
 */
const PRELOAD_LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "jsonc",
  "json5",
  "css",
  "scss",
  "html",
  "markdown",
  "mdx",
  "yaml",
  "yml",
  "toml",
  "python",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "csharp",
  "ruby",
  "php",
  "sql",
  "xml",
  "vue",
  "svelte",
  "astro",
  "zsh",
  "bash",
  "sh",
  "dockerfile",
  "properties",
  "ini",
  "csv",
  "graphql",
  "prisma",
  "makefile",
  "git-commit",
  "diff",
] as const;

let started = false;

/**
 * Kick the shared highlighter (both light/dark themes + common languages)
 * into the cache. Safe to call repeatedly; failures are swallowed — the
 * viewer falls back to per-file lazy loading, hidden behind its own loading
 * note until the first paint.
 */
export function preloadDiffHighlighter(): void {
  if (started) return;
  started = true;
  void preloadHighlighter({
    langs: [...PRELOAD_LANGS],
    themes: ["github-dark", "github-light"],
    preferredHighlighter: "shiki-js",
  }).catch(() => {
    // Preload is best-effort; the per-file lazy path still works.
  });
}
