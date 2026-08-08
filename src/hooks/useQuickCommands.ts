import { useSyncExternalStore } from "react";

import { getQuickCommands, subscribeQuickCommands } from "../lib/quickCommands";

/**
 * Live quick-commands settings. The store is shared with the Settings
 * editor: edits there re-render the composer immediately.
 */
export function useQuickCommands() {
  return useSyncExternalStore(subscribeQuickCommands, getQuickCommands);
}
