import { memo, useCallback } from "react";
import type { AnchorHTMLAttributes, ImgHTMLAttributes, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
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
 * Sanitizer schema: GitHub-flavoured defaults (p / img / a / table / lists …)
 * plus a small set of inline presentation attributes commonly used in local
 * docs. Scripts, iframes, event handlers and other executable HTML are
 * stripped by the default schema.
 */
const MARKDOWN_HTML_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // Allow width/height/align/center on media & tables (common in docs).
    img: [...(defaultSchema.attributes?.img ?? []), "width", "height", "align"],
    table: [...(defaultSchema.attributes?.table ?? []), "align"],
    td: [...(defaultSchema.attributes?.td ?? []), "align"],
    th: [...(defaultSchema.attributes?.th ?? []), "align"],
    p: [...(defaultSchema.attributes?.p ?? []), "align", "style"],
    span: [...(defaultSchema.attributes?.span ?? []), "style"],
    div: [...(defaultSchema.attributes?.div ?? []), "align", "style"],
  },
};

/**
 * React-markdown `components` map for workspace previews. Defined at module
 * level (not during render) so the components are stable across renders;
 * render-dependent handlers are passed in as arguments.
 */
function createMarkdownComponents({
  handleLinkClick,
  resolveWorkspacePath,
  onOpenWorkspacePath,
}: {
  handleLinkClick: (event: ReactMouseEvent<HTMLAnchorElement>, href: string | undefined) => void;
  resolveWorkspacePath: (target: string) => string | null;
  onOpenWorkspacePath: (absPath: string) => void;
}) {
  return {
    a({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { children?: ReactNode }) {
      return (
        <a {...props} href={href} onClick={(event) => handleLinkClick(event, href)}>
          {children}
        </a>
      );
    },
    img({ src, alt }: ImgHTMLAttributes<HTMLImageElement>) {
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
  };
}

/**
 * Markdown rendering for the file preview overlay. Relative links resolve
 * against the markdown file's directory; links that point at workspace files
 * open through the normal preview/editor routing, everything else falls back
 * to the system browser. Inline HTML (p / img / table …) is parsed via
 * rehype-raw and sanitized with a safe allowlist. Local images render as a
 * tappable placeholder that opens the workspace image preview (inline blobs
 * would need async loads).
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
        rehypePlugins={[
          [rehypeRaw, { passThrough: [] }],
          [rehypeSanitize, MARKDOWN_HTML_SCHEMA],
        ]}
        components={createMarkdownComponents({ handleLinkClick, resolveWorkspacePath, onOpenWorkspacePath })}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
