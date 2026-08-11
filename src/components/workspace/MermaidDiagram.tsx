import { ExternalLink } from "lucide-react";
import { Loader2 } from "lucide-react";
import mermaid from "mermaid";
import { memo, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { useTheme } from "../../lib/theme";
import type { AppDescriptor } from "../../types/contracts";

// One-time global setup. Per-render options (theme) are applied before each
// render so diagrams follow the app's light/dark theme live.
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  fontFamily: "inherit",
});

interface MermaidDiagramProps {
  /** Raw mermaid source from a ```mermaid fenced block. */
  code: string;
  /** Base name for the exported diagram file (defaults to "diagram"). */
  exportName?: string;
}

/**
 * Live mermaid diagram for ```mermaid fenced blocks in markdown previews.
 * Renders the diagram by default; a toolbar toggle reveals the raw source
 * (e.g. to copy it or debug a parse error). Failed parses fall back to the
 * source view with the error message. The diagram can be exported as an SVG
 * file and opened with a chosen app (Preview, browser, …) — useful for
 * complex diagrams that need zoom/pan.
 */
export const MermaidDiagram = memo(function MermaidDiagram({ code, exportName = "diagram" }: MermaidDiagramProps) {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const renderSequenceRef = useRef(0);
  const [mode, setMode] = useState<"diagram" | "source">("diagram");
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Last successfully rendered svg markup (for export). */
  const [svg, setSvg] = useState<string | null>(null);
  /** PNG export in flight (re-render + rasterize takes a moment). */
  const [exporting, setExporting] = useState(false);
  /** Apps declared to open .svg files (macOS). */
  const [svgApps, setSvgApps] = useState<AppDescriptor[]>([]);
  // mermaid uses the id on the svg; strip React's special characters.
  const diagramId = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  useEffect(() => {
    let cancelled = false;
    void window.ePi.app
      .appsForExtension("svg")
      .then((apps) => {
        if (!cancelled) setSvgApps(apps);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (mode !== "diagram" || !code.trim()) {
      setPending(false);
      setError(null);
      return;
    }
    const sequence = renderSequenceRef.current + 1;
    renderSequenceRef.current = sequence;
    setPending(true);
    setError(null);
    setSvg(null);
    mermaid.initialize({ theme: theme === "dark" ? "dark" : "default" });
    void (async () => {
      try {
        // mermaid renders into a temp element and REMOVES it before returning
        // (even when a container is passed), so take the svg string and insert
        // it ourselves — the documented usage.
        const result = await mermaid.render(diagramId, code);
        if (renderSequenceRef.current !== sequence) return;
        const container = containerRef.current;
        if (container) {
          container.innerHTML = result.svg;
          // Attach mermaid's click handlers (flowchart node click, zoom on
          // click, …) to the freshly inserted svg.
          result.bindFunctions?.(container);
        }
        setSvg(result.svg);
        setPending(false);
      } catch (reason) {
        if (renderSequenceRef.current !== sequence) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        containerRef.current?.replaceChildren();
        setError(message);
        setMode("source");
        setPending(false);
      }
    })();
  }, [code, diagramId, mode, theme]);

  /**
   * Rasterize a mermaid svg string to a PNG base64 payload. The canvas path
   * cannot draw `foreignObject` (HTML labels), so this only works on svg
   * rendered with htmlLabels:false — see exportPng.
   */
  const svgToPngBase64 = async (svgString: string): Promise<string> => {
    const viewBox = /viewBox="([^"]+)"/.exec(svgString)?.[1]?.split(/\s+/).map(Number) ?? [0, 0, 300, 150];
    const width = viewBox[2];
    const height = viewBox[3];
    const scale = 3;
    const blob = new Blob([svgString], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Failed to rasterize diagram"));
        img.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable");
      // Match the app background so dark-theme diagrams stay readable.
      ctx.fillStyle = getComputedStyle(document.body).backgroundColor || "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, width, height);
      return canvas.toDataURL("image/png").split(",")[1] ?? "";
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  /**
   * Export the diagram as a temp PNG file; returns its path. Mermaid's HTML
   * labels live in `foreignObject`, which the canvas rasterizer cannot draw,
   * so the export re-renders the diagram with htmlLabels:false (pure SVG
   * text) under an id distinct from the on-screen one. The file is temporary
   * by design: same name reused (no pile-up) and removed shortly after open.
   */
  const exportPng = async (): Promise<string> => {
    setExporting(true);
    try {
      mermaid.initialize({ htmlLabels: false, theme: theme === "dark" ? "dark" : "default" });
      const { svg: textSvg } = await mermaid.render(`${diagramId}-export`, code);
      const pngBase64 = await svgToPngBase64(textSvg);
      const safeName = exportName.replace(/[^a-zA-Z0-9._-]/g, "_");
      return window.ePi.app.writeTempFile(`mermaid-${safeName}.png`, pngBase64, true);
    } finally {
      // Restore HTML labels for any later on-screen re-render (theme switch).
      mermaid.initialize({ htmlLabels: true });
      setExporting(false);
    }
  };

  /** Open the exported PNG with a specific app (undefined = system default). */
  const openDiagram = async (appId?: string) => {
    try {
      const path = await exportPng();
      if (appId) await window.ePi.app.openWith(appId, path);
      else await window.ePi.app.openPath(path);
      // Temporary file: drop it once the viewer has had time to read it.
      window.setTimeout(
        () => {
          void window.ePi.app.removeTempFile(path).catch(() => undefined);
        },
        5 * 60 * 1000,
      );
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    }
  };

  /** "Other…": native app picker, then open the exported diagram with it. */
  const openDiagramWithPicker = async () => {
    try {
      const chosen = await window.ePi.app.chooseApp();
      if (chosen) await openDiagram(chosen);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const openMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="workspace-md-mermaid-toggle"
          title="Open diagram with an app"
          disabled={!svg || exporting}
        >
          <ExternalLink size={12} />
          <span>{exporting ? "导出中…" : "打开"}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="tool-file-app-submenu">
        <DropdownMenuLabel>打开方式</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => void openDiagram()}>系统默认</DropdownMenuItem>
        {svgApps.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            {svgApps.map((app) => (
              <DropdownMenuItem key={app.id} onSelect={() => void openDiagram(app.id)}>
                {app.icon ? <img src={app.icon} className="tool-file-app-icon" alt="" /> : null}
                {app.name}
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void openDiagramWithPicker()}>Other…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (mode === "source") {
    return (
      <div className="workspace-md-mermaid">
        <div className="workspace-md-mermaid-toolbar">
          <span className="workspace-md-mermaid-label">Mermaid</span>
          <button type="button" className="workspace-md-mermaid-toggle" onClick={() => setMode("diagram")}>
            显示图表
          </button>
        </div>
        {error ? (
          <div className="workspace-md-mermaid-error">
            <span className="workspace-md-mermaid-error-message">渲染失败：{error}</span>
          </div>
        ) : null}
        <pre className="workspace-md-mermaid-source">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="workspace-md-mermaid">
      <div className="workspace-md-mermaid-toolbar">
        <span className="workspace-md-mermaid-label">Mermaid</span>
        <div className="workspace-md-mermaid-actions">
          {openMenu}
          <button type="button" className="workspace-md-mermaid-toggle" onClick={() => setMode("source")}>
            查看源代码
          </button>
        </div>
      </div>
      {pending ? (
        <div className="workspace-md-mermaid-loading">
          <Loader2 size={14} className="spin" />
          <span>渲染中…</span>
        </div>
      ) : null}
      <div className="workspace-md-mermaid-body" ref={containerRef} />
    </div>
  );
});
