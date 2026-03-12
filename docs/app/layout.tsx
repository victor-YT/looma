import type { Metadata } from 'next';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { Manrope } from 'next/font/google';
import { Header } from '@/components/header';
import { siteConfig } from '@/lib/layout.shared';
import './global.css';
import { Analytics } from '@vercel/analytics/next';

const manrope = Manrope({
  subsets: ['latin'],
  weight: ["400", "500", "600", "700"],
  variable: '--font-manrope',
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: siteConfig.title,
    template: `%s | ${siteConfig.title}`,
  },
  description: siteConfig.description,
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={manrope.variable} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col pt-[var(--looma-header-height)] font-sans">
        <RootProvider>
          <Header />
          {children}
          <Analytics />
        </RootProvider>
      </body>
    </html>
  );
}
