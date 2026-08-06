import type { FileDiffOptions } from "@pierre/diffs";
import { PatchDiff } from "@pierre/diffs/react";
import { memo, useMemo, useState, type CSSProperties } from "react";

import { useIsDark } from "../hooks/useIsDark";

/** Review diff layout: side-by-side columns or a single unified column. */
export type DiffStyle = "split" | "unified";

/**
 * Diff-row tints adapted to the e-pi theme: deletion/addition bases come from
 * the theme's `--diff-*` variables (pierre palette, light + dark), and the
 * line-number column uses the panel's `--background-stronger`. Keeps the
 * opencode-style 30% alpha blend so rows read as a soft tint over the diff
 * background instead of standing out with mismatched saturation.
 */
const UNSAFE_CSS = `
:host {
  /* pierre's theme CSS paints the host with the shiki theme background;
     drop it so the panel's own diff background (--diff-bg) shows through. */
  background-color: transparent;
}
[data-diff] {
  --diffs-bg: transparent;
  --diffs-bg-separator: var(--background-stronger);
  --diffs-fg: var(--foreground);
  --diffs-bg-deletion-override: color-mix(in oklch, transparent 70%, var(--diff-del-base));
  --diffs-bg-addition-override: color-mix(in oklch, transparent 70%, var(--diff-add-base));
}
[data-diff] [data-column-number] {
  background-color: var(--background-stronger, color-mix(in oklch, var(--background) 90%, var(--foreground)));
}
`;

const WRAPPER_STYLE = {
  "--diffs-font-family": 'ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", monospace',
  "--diffs-font-size": "var(--fs-diff)",
  "--diffs-line-height": "24px",
  "--diffs-tab-size": "2",
  "--diffs-min-number-column-width": "4ch",
  "--diffs-gap-block": "0",
} as CSSProperties;

/**
 * OpenCode-identical diff body via the `@pierre/diffs` engine (the same
 * library opencode desktop uses): Shiki syntax highlighting, bars
 * indicators, line-info-basic hunk separators, split/unified layouts.
 */
export const DiffView = memo(function DiffView({ patch, style }: { patch: string; style: DiffStyle }) {
  const isDark = useIsDark();
  // The engine paints asynchronously on its first render while the Shiki
  // highlighter warms up (see preloadDiffHighlighter); onPostRender only
  // fires once real content is in the DOM, so hide the blank window behind
  // a loading note until the first successful paint.
  const [painted, setPainted] = useState(false);

  const options = useMemo<FileDiffOptions<undefined>>(
    () => ({
      theme: isDark ? "github-dark" : "github-light",
      themeType: isDark ? "dark" : "light",
      disableLineNumbers: false,
      overflow: "scroll",
      diffStyle: style,
      diffIndicators: "bars",
      hunkSeparators: "line-info-basic",
      lineDiffType: style === "split" ? "word-alt" : "none",
      maxLineDiffLength: 1000,
      expansionLineCount: 20,
      disableFileHeader: true,
      onPostRender: () => setPainted(true),
      unsafeCSS: UNSAFE_CSS,
    }),
    [isDark, style],
  );

  const wrapperStyle = useMemo(() => ({ ...WRAPPER_STYLE }), []);

  if (!patch) {
    return <div className="git-diff-empty">No changes for this file</div>;
  }
  // git marks binary diffs with a meta line like "Binary files a/x and b/x
  // differ". Anchor at line start so file *content* containing that string
  // (e.g. parser tests) is not mistaken for a binary diff.
  if (/^Binary files .+ differ$/m.test(patch)) {
    return <div className="git-diff-empty">Binary file</div>;
  }
  const truncated = patch.includes("\n[diff truncated]\n");
  const cleanPatch = truncated ? patch.replace(/\n?\[diff truncated\]\n?/g, "") : patch;
  return (
    <div className="git-diff-pierre" style={wrapperStyle}>
      <PatchDiff patch={cleanPatch} options={options} disableWorkerPool />
      {!painted ? <div className="git-diff-loading">加载中…</div> : null}
      {truncated ? <div className="git-diff-truncated">Diff truncated for display</div> : null}
    </div>
  );
});
