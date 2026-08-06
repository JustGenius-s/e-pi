import { useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";

/** Shared Electron/WebKit IME guard for inputs whose Enter key submits. */
export function useImeComposition() {
  const composingRef = useRef(false);

  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);

  const onCompositionEnd = useCallback(() => {
    // WebKit may deliver the composition-committing Enter after compositionend.
    window.setTimeout(() => {
      composingRef.current = false;
    }, 0);
  }, []);

  const isComposing = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    return composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
  }, []);

  return { onCompositionStart, onCompositionEnd, isComposing };
}
