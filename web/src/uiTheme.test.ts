import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyUiTheme,
  LIGHT_THEME_COLOR,
  readUiTheme,
  saveUiTheme,
  setUiTheme,
  UI_THEME_KEY
} from "./uiTheme";

const storage = () => ({
  getItem: vi.fn<(key: string) => string | null>(),
  setItem: vi.fn<(key: string, value: string) => void>()
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.colorScheme = "";
  document.querySelector('meta[name="theme-color"]')?.remove();
});

describe("ui theme preference", () => {
  it("defaults to dark and accepts a saved light preference", () => {
    const browserStorage = storage();
    expect(readUiTheme(browserStorage)).toBe("dark");
    browserStorage.getItem.mockReturnValue("light");
    expect(readUiTheme(browserStorage)).toBe("light");
  });

  it("saves and applies the selected theme", () => {
    const browserStorage = storage();
    saveUiTheme("light", browserStorage);
    expect(browserStorage.setItem).toHaveBeenCalledWith(UI_THEME_KEY, "light");

    const themeMeta = document.createElement("meta");
    themeMeta.name = "theme-color";
    document.head.append(themeMeta);
    const documentElement = document.documentElement;
    setUiTheme("light", documentElement, browserStorage);
    expect(documentElement.dataset.theme).toBe("light");
    expect(documentElement.style.colorScheme).toBe("light");
    expect(themeMeta.content).toBe(LIGHT_THEME_COLOR);

    browserStorage.getItem.mockReturnValue("dark");
    expect(applyUiTheme(documentElement, browserStorage)).toBe("dark");
    expect(documentElement.dataset.theme).toBe("dark");
  });
});
