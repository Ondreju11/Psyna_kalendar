import type { Metadata } from 'next';

import './globals.css';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const socialImage = new URL(`${basePath}/og.png`, siteUrl).toString();

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'Kalendář akcí',
  description:
    'Sdílejte jednu akci nebo přehled více akcí a přidejte je do kalendáře.',
  openGraph: {
    title: 'Kalendář akcí',
    description:
      'Sdílejte jednu akci nebo přehled více akcí a přidejte je do kalendáře.',
    type: 'website',
    locale: 'cs_CZ',
    images: [
      {
        url: socialImage,
        width: 1731,
        height: 909,
        alt: 'Kalendář akcí – vytvořte odkaz na událost',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Kalendář akcí',
    description:
      'Sdílejte jednu akci nebo přehled více akcí a přidejte je do kalendáře.',
    images: [socialImage],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="cs">
      <body>{children}</body>
    </html>
  );
}
