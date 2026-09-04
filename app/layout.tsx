import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://waitland.app"),
  title: "Waitland — A little wait. Something lasting.",
  description: "Waiting for something? Pick up a rock, toss it in the shared pit, and help strangers build a monument. No accounts. Just a little of your time.",
  openGraph: {
    title: "Waitland — A little wait. Something lasting.",
    description: "Pick up a rock. Toss it in the pit. Together, turn the waiting into a monument.",
    url: "/",
    siteName: "Waitland",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Waitland, a shared little world where waiting becomes a monument",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Waitland — A little wait. Something lasting.",
    description: "Pick up a rock. Toss it in the pit. Together, turn the waiting into a monument.",
    images: ["/og.png"],
  },
  icons: {
    icon: [{ url: "/favicon.png", type: "image/png", sizes: "128x128" }],
    shortcut: "/favicon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f5f1e7",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
