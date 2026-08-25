import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://waitland.app"),
  title: "Waitland",
  description: "Arrive from anywhere, wander the field, and carry one stone to the pit while you wait.",
  openGraph: {
    title: "Waitland",
    description: "Arrive. Wander. Carry one stone to the pit.",
    url: "/",
    siteName: "Waitland",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "A lone person carrying a stone toward the central pit in Waitland",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Waitland",
    description: "Arrive. Wander. Carry one stone to the pit.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#c6a86e",
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
