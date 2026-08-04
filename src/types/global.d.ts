import type { EPiApi } from "./contracts";

declare global {
  interface Window {
    ePi: EPiApi;
  }
}

export {};
