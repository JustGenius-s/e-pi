/**
 * Unified diff parser for the review file diff view.
 *
 * Parses `git diff` text into hunks with old/new line numbers, and computes
 * word-level change highlights for paired deletion/addition lines (the
 * same inline-emphasis the OpenCode desktop diff shows).
 */

export type DiffLineType = "context" | "add" | "del";

export interface DiffLine {
  type: DiffLineType;
  /** Line number in the old file (context/del lines). */
  oldNo: number | null;
  /** Line number in the new file (context/add lines). */
  newNo: number | null;
  /** Line content without the +/- prefix. */
  text: string;
  /** [start, end) character ranges emphasized with word-level highlight. */
  highlights: ReadonlyArray<readonly [number, number]>;
  /** A "\ No newline at end of file" marker follows this line. */
  noNewline: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Trailing text after the @@ range, e.g. " export function foo() {". */
  heading: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  /** The file is binary; no hunks can be rendered. */
  binary: boolean;
  /** The diff text was truncated at the source. */
  truncated: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Word-diff bail-out: token product above this skips inline highlighting. */
const MAX_WORD_DIFF_TOKENS = 400;

interface WordToken {
  key: string;
  start: number;
  end: number;
}

function tokenize(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  const re = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    tokens.push({ key: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/**
 * Longest-common-subsequence word diff. Returns character ranges of the
 * non-matching words in each input; both inputs are highlighted symmetrically.
 */
function wordDiffRanges(
  oldText: string,
  newText: string,
): { oldRanges: Array<[number, number]>; newRanges: Array<[number, number]> } {
  const oldWords = tokenize(oldText);
  const newWords = tokenize(newText);
  const empty = { oldRanges: [] as Array<[number, number]>, newRanges: [] as Array<[number, number]> };
  if (oldWords.length * newWords.length > MAX_WORD_DIFF_TOKENS * MAX_WORD_DIFF_TOKENS) return empty;

  const m = oldWords.length;
  const n = newWords.length;
  const stride = n + 1;
  // DP table over token indices; values are LCS lengths (≤ max(m, n)).
  const dp = new Uint16Array((m + 1) * stride);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * stride + j] =
        oldWords[i]!.key === newWords[j]!.key
          ? dp[(i + 1) * stride + j + 1]! + 1
          : Math.max(dp[(i + 1) * stride + j]!, dp[i * stride + j + 1]!);
    }
  }

  const oldRanges: Array<[number, number]> = [];
  const newRanges: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldWords[i]!.key === newWords[j]!.key) {
      i++;
      j++;
    } else if (dp[(i + 1) * stride + j]! >= dp[i * stride + j + 1]!) {
      oldRanges.push([oldWords[i]!.start, oldWords[i]!.end]);
      i++;
    } else {
      newRanges.push([newWords[j]!.start, newWords[j]!.end]);
      j++;
    }
  }
  while (i < m) {
    oldRanges.push([oldWords[i]!.start, oldWords[i]!.end]);
    i++;
  }
  while (j < n) {
    newRanges.push([newWords[j]!.start, newWords[j]!.end]);
    j++;
  }
  return { oldRanges, newRanges };
}

export function parseDiff(text: string): ParsedDiff {
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let binary = false;
  let truncated = false;
  let hunk: DiffHunk | null = null;
  let pendingDels: DiffLine[] = [];
  let oldCursor = 0;
  let newCursor = 0;

  for (const raw of text.split("\n")) {
    if (raw.startsWith("Binary files")) {
      binary = true;
      break;
    }
    const hunkMatch = HUNK_RE.exec(raw);
    if (hunkMatch !== null) {
      hunk = {
        oldStart: Number(hunkMatch[1]),
        oldCount: hunkMatch[2] ? Number(hunkMatch[2]) : 1,
        newStart: Number(hunkMatch[3]),
        newCount: hunkMatch[4] ? Number(hunkMatch[4]) : 1,
        heading: hunkMatch[5] ?? "",
        lines: [],
      };
      pendingDels = [];
      oldCursor = hunk.oldStart;
      newCursor = hunk.newStart;
      hunks.push(hunk);
      continue;
    }
    if (hunk === null) continue; // meta lines before the first hunk
    if (raw === "[diff truncated]") {
      truncated = true;
      continue;
    }
    const marker = raw[0];
    if (marker === "\\") {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last !== undefined) last.noNewline = true;
      continue;
    }
    if (marker !== "+" && marker !== "-" && marker !== " ") continue;

    const isAdd = marker === "+";
    const isDel = marker === "-";
    const line: DiffLine = {
      type: isAdd ? "add" : isDel ? "del" : "context",
      oldNo: isAdd ? null : oldCursor,
      newNo: isDel ? null : newCursor,
      text: raw.slice(1),
      highlights: [],
      noNewline: false,
    };
    hunk.lines.push(line);
    if (!isAdd) oldCursor++;
    if (!isDel) newCursor++;

    if (isAdd) {
      additions++;
      const del = pendingDels.shift();
      if (del !== undefined) {
        const { oldRanges, newRanges } = wordDiffRanges(del.text, line.text);
        del.highlights = oldRanges;
        line.highlights = newRanges;
      }
    } else if (isDel) {
      deletions++;
      pendingDels.push(line);
    } else {
      pendingDels = [];
    }
  }

  return { binary, truncated, hunks, additions, deletions };
}
