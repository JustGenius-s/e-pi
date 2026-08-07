import { memo, useCallback } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { isWorkspacePreviewPath } from "../../lib/workspacePreviewKind";

interface WorkspaceMarkdownPreviewProps {
  /** Absolute path of the markdown file being rendered. */
  markdownPath: string;
  cwd: string;
  content: string;
  className?: string;
  /** Open a workspace path (from a relative link). */
  onOpenWorkspacePath: (absPath: string) => void;
}

/**
 * Markdown rendering for the file preview overlay. Relative links resolve
 * against the markdown file's directory; links that point at workspace files
 * open through the normal preview/editor routing, everything else falls back
 * to the system browser. Local images render as a tappable placeholder that
 * opens the workspace image preview (inline blobs would need async loads).
 */
export const WorkspaceMarkdownPreview = memo(function WorkspaceMarkdownPreview({
  markdownPath,
  cwd,
  content,
  className,
  onOpenWorkspacePath,
}: WorkspaceMarkdownPreviewProps) {
  const resolveWorkspacePath = useCallback(
    (target: string): string | null => {
      const normalized = target.replace(/\\/g, "/");
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized) || normalized.startsWith("//")) return null;
      if (normalized.startsWith("/")) {
        return normalized.startsWith(cwd) ? normalized : null;
      }
      const dir = markdownPath.slice(0, markdownPath.lastIndexOf("/") + 1);
      const parts: string[] = [];
      for (const segment of `${dir}${normalized}`.split("/")) {
        if (!segment || segment === ".") continue;
        if (segment === "..") {
          parts.pop();
          continue;
        }
        parts.push(segment);
      }
      const abs = parts.join("/");
      return abs.startsWith(cwd) ? abs : null;
    },
    [cwd, markdownPath],
  );

  const handleLinkClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>, href: string | undefined) => {
      if (!href) return;
      const stripped = href.split("#")[0];
      if (!stripped) return;
      const abs = resolveWorkspacePath(stripped);
      if (!abs) return; // External URL — default browser behavior.
      event.preventDefault();
      onOpenWorkspacePath(abs);
    },
    [onOpenWorkspacePath, resolveWorkspacePath],
  );

  return (
    <div className={`workspace-md-preview ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children, ...props }) {
            return (
              <a {...props} href={href} onClick={(event) => handleLinkClick(event, href)}>
                {children}
              </a>
            );
          },
          img({ src, alt }) {
            const abs = resolveWorkspacePath(src ?? "");
            if (abs && isWorkspacePreviewPath(abs)) {
              return (
                <button
                  type="button"
                  className="workspace-md-preview-local-image"
                  title={alt ? `${alt} (click to preview)` : "Click to preview"}
                  onClick={() => onOpenWorkspacePath(abs)}
                >
                  <span>🖼 {alt || abs.split("/").pop()}</span>
                </button>
              );
            }
            return <img src={src} alt={alt ?? ""} loading="lazy" />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
