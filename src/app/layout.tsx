import type { Metadata } from 'next';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'Prospecting',
  description: 'AI lead discovery, enrichment, intent signals and outreach.',
};

/**
 * Root layout.
 *
 * Two providers — theme and auth — and nothing else. Every global provider
 * is something every page pays for, so only what prospecting actually needs
 * lives here.
 *
 * The inline script runs before paint and applies the persisted theme class,
 * which stops the light-theme flash on first load. ThemeProvider picks up the
 * same localStorage key on mount.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark')}}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
