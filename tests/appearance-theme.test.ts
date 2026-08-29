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

  it("overrides Tailwind @theme ink tokens in the same theme layer so light-mode text stays readable", async () => {
    const theme = await readFile(resolve(import.meta.dirname, "../src/ui/theme.css"), "utf8");
    const lightStart = theme.indexOf('html[data-theme="light"]');
    expect(lightStart).toBeGreaterThan(-1);
    expect(theme.slice(0, lightStart)).toContain("@layer theme");
    const lightBlock = theme.slice(lightStart, theme.indexOf("}", lightStart) + 1);
    expect(lightBlock).toContain("html.light");
    expect(lightBlock).toMatch(/--color-ink:\s*rgba\(9,\s*9,\s*11,\s*0\.80\)/);
    expect(lightBlock).toMatch(/--color-ink-label:\s*rgba\(9,\s*9,\s*11,\s*0\.38\)/);
    expect(lightBlock).not.toMatch(/--color-ink:\s*rgba\(255,\s*255,\s*255/);
  });
});
