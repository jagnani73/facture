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
    default: 'Facture · short-dated receivable paper',
    template: '%s · Facture',
  },
  description:
    'An invoice is a zero-coupon bond that nobody ever priced. Facture prices every invoice off standing bids, the moment it appears.',
};

/**
 * One colour, because the page no longer follows the OS by default. A reader who
 * has opted into Night gets light chrome around a dark page, which is the smaller
 * of the two mismatches: the other one would hit everyone on a dark desktop who
 * never chose anything.
 */
export const viewport: Viewport = {
  themeColor: '#f8f3ea',
};

/**
 * Applied before first paint so a chosen theme never flashes the other one.
 * Light is the default: anything other than a stored `system` gets the attribute
 * outright, so an unreadable localStorage lands on Day rather than on the OS.
 */
const THEME_BOOTSTRAP = `(function(){var d=document.documentElement;var t=null;try{t=localStorage.getItem('facture-theme')}catch(e){}if(t==='system'){d.removeAttribute('data-theme')}else{d.setAttribute('data-theme',t==='dark'?'dark':'light')}})()`;

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
