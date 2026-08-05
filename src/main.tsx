import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@xterm/xterm/css/xterm.css";
import "./styles/app.css";
import "./styles/git.css";
import { App } from "./App";
import { TooltipProvider } from "./components/ui/tooltip";
import { applyInitialTheme } from "./lib/theme";

// Stored choice first, else the OS setting — before first paint, so the
// window never flashes the wrong theme.
applyInitialTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
