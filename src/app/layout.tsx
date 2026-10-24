import type { Metadata } from "next";
import { AnimatedBackground } from "@/components/animated-background";
import { SignInDialog } from "@/components/sign-in-dialog";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lumap — London venue map",
  description: "Find trusted community venues across London.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <AnimatedBackground />
        {children}
        <SignInDialog />
      </body>
    </html>
  );
}
