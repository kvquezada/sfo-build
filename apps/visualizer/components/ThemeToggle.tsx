"use client";

/**
 * Light/dark switch.
 *
 * Holds no React state on purpose. The theme lives in one place — the
 * `data-theme` attribute on <html>, set before first paint by the inline
 * script in layout.tsx — and both icons are always rendered, with CSS showing
 * whichever one the current theme calls for. A server that cannot know the
 * viewer's choice therefore renders the same markup the client hydrates,
 * so there is no mismatch to suppress and no flash of the wrong icon.
 *
 * The icon shows the theme you would GET, not the one you are in.
 */
export function ThemeToggle() {
  function toggle() {
    const root = document.documentElement;
    const next = root.dataset["theme"] === "light" ? "dark" : "light";
    root.dataset["theme"] = next;
    // A viewer with site data blocked still gets the toggle, just not the
    // memory of it.
    try {
      localStorage.setItem("sfo-theme", next);
    } catch {
      /* ignore */
    }
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      title="Switch between light and dark"
      aria-label="Switch between light and dark"
    >
      <span className="theme-icon theme-sun" aria-hidden="true">
        ☀
      </span>
      <span className="theme-icon theme-moon" aria-hidden="true">
        ☾
      </span>
    </button>
  );
}
