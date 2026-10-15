// ============================================================
//  Redirect local - theme.js
//  Loaded in <head> so the saved theme is applied before first paint,
//  and kept independent from popup.js so a runtime error there can
//  never break the theme toggle.
// ============================================================
(() => {
  const KEY = "nec-theme";
  const root = document.documentElement;

  function current() {
    return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function apply(theme) {
    root.setAttribute("data-theme", theme);
    root.style.colorScheme = theme; // native controls (select, scrollbar, textarea) follow too
    try { localStorage.setItem(KEY, theme); } catch {}
    const btn = document.getElementById("theme");
    if (btn) {
      btn.textContent = theme === "dark" ? "☀️" : "🌙";
      btn.title = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
    }
  }

  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch {}
  apply(saved === "dark" || saved === "light" ? saved : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));

  document.addEventListener("DOMContentLoaded", () => {
    apply(current()); // sync the button icon once it exists
    document.getElementById("theme")?.addEventListener("click", () => apply(current() === "dark" ? "light" : "dark"));
  });
})();
