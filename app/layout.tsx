import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voice Inbox – Sprich es aus",
  description: "Eine lokale Voice-Inbox für Gedanken, Aufgaben und Termine.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="de"><body>{children}</body></html>;
}
