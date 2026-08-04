import { ArrowUp, Square } from "lucide-react";
import { useState } from "react";
import type { PiProcessStatus } from "../types/contracts";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

interface ComposerProps {
  status: PiProcessStatus;
  disabled: boolean;
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
}

export function Composer({ status, disabled, onSubmit, onInterrupt }: ComposerProps) {
  const [text, setText] = useState("");
  const busy = status === "starting" || status === "stopping";

  const submit = () => {
    const value = text.trim();
    if (!value || disabled || busy) return;
    onSubmit(text);
    setText("");
  };

  return (
    <div className="composer-shell">
      <Textarea
        aria-label="Message Pi"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={disabled ? "Select a session to start writing" : "Ask Pi to inspect, change, or explain..."}
        disabled={disabled || busy}
        rows={1}
      />
      <div className="composer-toolbar">
        <div className="composer-actions">
          {status === "running" ? (
            <Button variant="destructive" size="sm" onClick={onInterrupt} aria-label="Interrupt Pi">
              <Square size={11} fill="currentColor" />
              <span>Stop</span>
            </Button>
          ) : null}
          <Button size="sm" onClick={submit} disabled={!text.trim() || disabled || busy}>
            <ArrowUp size={15} />
            <span>Send</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
