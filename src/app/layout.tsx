import type { Metadata, Viewport } from "next";
import { Schibsted_Grotesk, Geist_Mono } from "next/font/google";
import { SignInDialog } from "@/components/sign-in-dialog";
import "./globals.css";

const sans = Schibsted_Grotesk({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800"], variable: "--font-schibsted", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = {
  title: "So where?",
  description: "Ask in plain English where to meet or what to do in London. Three honest options on a map: who travels how long, what's confirmed, what's unknown.",
  openGraph: { title: "So where?", description: "Where shall we meet? Plain-English plans on a London map, every fact with its source." },
};

export const viewport: Viewport = { themeColor: "#eeede8", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-GB" className={`${sans.variable} ${mono.variable}`}>
      <body className="font-sans">
        {children}
        {/* kept for the legacy /review and /events pages */}
        <SignInDialog />
      </body>
    </html>
  );
}
