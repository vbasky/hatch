import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { followSystemFromStoredValue } from "../extensions/appearance/theme";

describe("appearance follow-system default", () => {
  it("follows the OS when no stored preference exists", () => {
    expect(followSystemFromStoredValue(undefined)).toBe(true);
    expect(followSystemFromStoredValue(null)).toBe(true);
    expect(followSystemFromStoredValue(1)).toBe(true);
    expect(followSystemFromStoredValue(0)).toBe(false);
  });

  it("keeps the window chrome transparent in light mode so rounded corners punch through", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../extensions/appearance/theme.ts"), "utf8");
    expect(source).toMatch(/html\[data-theme="light"\] #root \{\s*background: transparent;/s);
  });
});
