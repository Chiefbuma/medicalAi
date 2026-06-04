import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RadiantMedAI",
  description: "RadiantMedAI clinical chat UI powered by LangChain, Ollama, and Qdrant",
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
