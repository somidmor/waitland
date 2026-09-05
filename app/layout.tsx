import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://waitland.app"),
  title: "Waitland — Throw rocks while you wait.",
  description: "Waiting for something? Pick up a rock, toss it in the shared pit, and help strangers build a monument. Open the field and play. No account needed.",
  openGraph: {
    title: "Waitland — Throw rocks while you wait.",
    description: "Pick up a rock. Toss it in the pit. Fill a shared pit and build a dated stone statue.",
    url: "/",
    siteName: "Waitland",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Waitland, a shared sculpture park built one rock at a time",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Waitland — Throw rocks while you wait.",
    description: "Pick up a rock. Toss it in the pit. Fill a shared pit and build a dated stone statue.",
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
  themeColor: "#f6f2e7",
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
