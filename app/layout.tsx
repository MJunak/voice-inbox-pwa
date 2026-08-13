import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voice Inbox",
  description: "Lokale Voice-Inbox für Notizen, Aufgaben, Termine und Ideen.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="de"><body>{children}</body></html>;
}
