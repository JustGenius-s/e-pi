import { useEffect, useState } from "react";

/**
 * Tracks the `dark` class on <html> so theme-dependent consumers (diff
 * viewer, xterm terminals) follow the app theme live, without prop drilling.
 */
export function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setIsDark(root.classList.contains("dark")));
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}
