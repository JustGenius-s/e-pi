import { describe, expect, it } from "vitest";

import { fitToTerminalElement, proposeDimensionsForElement } from "../src/lib/xtermFit";

function fakeTerminal(clientWidth: number, clientHeight: number, cell = { width: 7.5, height: 16 }) {
  return {
    element: { clientWidth, clientHeight },
    _core: {
      _renderService: {
        dimensions: { css: { cell } },
      },
    },
  };
}

describe("proposeDimensionsForElement", () => {
  it("fits cols to the element content box, not a padded parent border-box", () => {
    // Runtime: panel border-box produced 114 cols / 855px canvas vs 812px xterm.
    expect(proposeDimensionsForElement(fakeTerminal(812, 512) as never)).toEqual({ cols: 108, rows: 32 });
  });

  it("returns undefined when the element is not mounted", () => {
    expect(proposeDimensionsForElement({ element: undefined } as never)).toBeUndefined();
  });
});

describe("fitToTerminalElement", () => {
  it("replaces FitAddon proposeDimensions with the element measurement", () => {
    const terminal = fakeTerminal(812, 512);
    const fit = { proposeDimensions: () => ({ cols: 114, rows: 32 }) };
    fitToTerminalElement(fit as never, terminal as never);
    expect(fit.proposeDimensions()).toEqual({ cols: 108, rows: 32 });
  });
});
