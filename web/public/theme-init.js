(() => {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  try {
    root.dataset.theme =
      globalThis.localStorage?.getItem("soenarto_tree_theme") === "light" ? "light" : "dark";
  } catch {
    root.dataset.theme = "dark";
  }
})();
