import { useSyncExternalStore } from "react";

export type UiTheme = "dark" | "light";

export const UI_THEME_KEY = "soenarto_tree_theme";
export const THEME_CHANGE_EVENT = "soenarto-tree:theme-change";
export const DARK_THEME_COLOR = "#0b2942";
export const LIGHT_THEME_COLOR = "#f7f3ec";

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

const browserStorage = (): ThemeStorage | undefined => {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

const themeFromDocument = (): UiTheme => {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
};

export const readUiTheme = (storage: ThemeStorage | undefined = browserStorage()): UiTheme => {
  try {
    return storage?.getItem(UI_THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
};

export const saveUiTheme = (
  theme: UiTheme,
  storage: ThemeStorage | undefined = browserStorage()
): void => {
  try {
    storage?.setItem(UI_THEME_KEY, theme);
  } catch {
    // Browser privacy settings can make localStorage unavailable.
  }
};

const updateThemeColor = (theme: UiTheme, documentElement: HTMLElement) => {
  const themeColor = documentElement.ownerDocument?.querySelector('meta[name="theme-color"]');
  themeColor?.setAttribute("content", theme === "dark" ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
};

export const applyUiTheme = (
  documentElement: HTMLElement,
  storage: ThemeStorage | undefined = browserStorage()
): UiTheme => {
  const theme = readUiTheme(storage);
  documentElement.dataset.theme = theme;
  documentElement.style.colorScheme = theme;
  updateThemeColor(theme, documentElement);
  return theme;
};

export const setUiTheme = (
  theme: UiTheme,
  documentElement: HTMLElement | undefined = typeof document === "undefined"
    ? undefined
    : document.documentElement,
  storage: ThemeStorage | undefined = browserStorage()
): void => {
  saveUiTheme(theme, storage);
  if (!documentElement) return;
  documentElement.dataset.theme = theme;
  documentElement.style.colorScheme = theme;
  updateThemeColor(theme, documentElement);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: theme }));
  }
};

const subscribeToTheme = (onChange: () => void) => {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(THEME_CHANGE_EVENT, onChange);
};

export const useUiTheme = (): UiTheme => useSyncExternalStore(
  subscribeToTheme,
  themeFromDocument,
  () => "dark"
);
