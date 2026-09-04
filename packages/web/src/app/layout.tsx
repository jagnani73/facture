import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Archivo, JetBrains_Mono, Newsreader } from 'next/font/google';

import './globals.css';

/**
 * Three families, three jobs.
 *
 *   Newsreader  — the editorial voice. A screen-native text serif drawn for news,
 *                 which is what a page of paper prices is.
 *   Archivo     — the chrome. A grotesque with a high x-height that holds up at
 *                 label sizes and does not draw attention away from figures.
 *   JetBrains Mono — the ledger column. Genuinely tabular, unambiguous zero.
 *
 * All three are variable, so weight costs nothing extra.
 */
const newsreader = Newsreader({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  variable: '--font-newsreader',
  display: 'swap',
});

const archivo = Archivo({
  subsets: ['latin'],
  variable: '--font-archivo',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Facture — short-dated receivable paper',
    template: '%s · Facture',
  },
  description:
    'An invoice is a zero-coupon bond that nobody ever priced. Facture prices every invoice off standing bids, the moment it appears.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8f3ea' },
    { media: '(prefers-color-scheme: dark)', color: '#13120f' },
  ],
};

/** Applied before first paint so a chosen theme never flashes the other one. */
const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem('facture-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})()`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${newsreader.variable} ${archivo.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
