import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "SFO - Build",
  description: "Trace viewer for the software factory",
};

/**
 * Resolve the theme before the first paint.
 *
 * This has to be inline and blocking: a theme applied after hydration is a
 * white flash on every navigation for anyone reading in the dark, which is
 * most of the time for a trace viewer. Stored choice wins, the OS preference
 * is the fallback, and dark is the floor if neither can be read.
 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("sfo-theme");
if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";}
document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme="dark";}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The script writes data-theme before React looks, which is exactly the
    // attribute mismatch this suppresses.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
