/**
 * Programs that take over the tty with a keystroke-driven UI. While one of
 * these owns the foreground process group, the panel's command editor steps
 * aside and xterm receives raw keystrokes.
 *
 * Plain commands (sleep, builds, git status, …) deliberately stay OFF the
 * list: they must not disable the editor while they run, and lines typed
 * during their execution are valid type-ahead stdin, exactly like a normal
 * terminal. Shells are excluded too — a nested bash/zsh is line-oriented
 * and works fine with the command editor.
 */
const INTERACTIVE_PROGRAMS: readonly string[] = [
  // password / privilege prompts (echo-off input must never hit the editor)
  "sudo",
  "doas",
  "su",
  "login",
  "passwd",
  "ssh-add",
  // editors & pagers
  "vi",
  "vim",
  "nvim",
  "view",
  "nano",
  "pico",
  "emacs",
  "emacsclient",
  "micro",
  "hx",
  "helix",
  "kak",
  "joe",
  "less",
  "more",
  "most",
  "man",
  "info",
  // remote / serial
  "ssh",
  "mosh",
  "mosh-client",
  "telnet",
  "ftp",
  "sftp",
  "ncftp",
  "lftp",
  "rlogin",
  // full-screen monitors
  "top",
  "htop",
  "btop",
  "atop",
  "glances",
  "iotop",
  "iftop",
  "nmon",
  "bandwhich",
  "bmon",
  // REPLs & database consoles
  "python",
  "ipython",
  "node",
  "deno",
  "bun",
  "ruby",
  "irb",
  "pry",
  "perl",
  "php",
  "lua",
  "luajit",
  "r",
  "julia",
  "ghci",
  "scala",
  "sbt",
  "clojure",
  "clj",
  "erl",
  "iex",
  "gdb",
  "lldb",
  "mysql",
  "mycli",
  "psql",
  "pgcli",
  "sqlite3",
  "redis-cli",
  "mongo",
  "mongosh",
  "sqlplus",
  "influx",
  // TUIs, pickers & interactive CLIs
  "fzf",
  "lazygit",
  "lazydocker",
  "lazynpm",
  "tig",
  "gitui",
  "k9s",
  "ranger",
  "nnn",
  "lf",
  "mc",
  "vifm",
  "yazi",
  "broot",
  "mutt",
  "neomutt",
  "alpine",
  "weechat",
  "irssi",
  "newsboat",
  "gh",
  "glab",
  // terminal multiplexers
  "tmux",
  "screen",
  "abduco",
  "dtach",
  "zellij",
  // nested agent TUIs
  "claude",
  "codex",
  "pi",
  "gemini",
  "aider",
  "opencode",
  "crush",
  "cursor-agent",
];

const INTERACTIVE_SET = new Set(INTERACTIVE_PROGRAMS);

/**
 * Normalize a foreground process name to a comparable basename. Input is the
 * foreground process-group command as reported by node-pty (`IPty.process`):
 * p_comm on macOS (truncated to 16 chars, login shells may carry a leading
 * dash) or argv[0] on Linux.
 */
export function foregroundBasename(foreground: string): string {
  return foreground.split(/[\\/]/).pop()?.replace(/^-+/, "").trim().toLowerCase() ?? "";
}

/** Decide whether the tty's foreground process wants raw keystrokes. */
export function isInteractiveForeground(foreground: string): boolean {
  const base = foregroundBasename(foreground);
  if (base === "") return false;
  if (INTERACTIVE_SET.has(base)) return true;
  // Versioned binaries ("python3.11", "lua5.4", "node22") match their stem.
  const stem = base.replace(/[\d.]+$/, "");
  return stem !== base && stem !== "" && INTERACTIVE_SET.has(stem);
}
