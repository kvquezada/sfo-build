import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "sfo-build",
  description: "Trace viewer for the software factory",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
