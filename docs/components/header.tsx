'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Github, Moon, Navigation, PanelLeft, Search, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useSearchContext } from 'fumadocs-ui/contexts/search';
import { docsSidebarToggleEvent, siteConfig } from '@/lib/layout.shared';

function SearchButton({ compact = false }: { compact?: boolean }) {
  const { enabled, setOpenSearch } = useSearchContext();

  if (!enabled) return null;

  return (
    <button
      type="button"
      aria-label="Open search"
      onClick={() => setOpenSearch(true)}
      className={`inline-flex items-center justify-center rounded-full border border-fd-border bg-fd-card text-sm font-normal text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground ${
        compact ? 'size-9 sm:hidden' : 'hidden gap-2 px-3 py-2 sm:inline-flex'
      }`}
    >
      <Search className="size-4" />
      {!compact ? <span>Search</span> : null}
    </button>
  );
}

function ThemeButton() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = mounted && resolvedTheme === 'dark';

  return (
    <button
      type="button"
      aria-label="Toggle theme"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className="inline-flex size-9 items-center justify-center rounded-full border border-fd-border bg-fd-card text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

function HeaderLogo() {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const logoSrc = mounted && resolvedTheme === 'dark'
    ? '/logo_white.svg'
    : '/logo_black.svg';

  return (
    <img
      src={logoSrc}
      alt="AfferLab logo"
      width={23}
      height={23}
      className="h-[23px] w-[23px] shrink-0"
    />
  );
}

export function Header() {
  return (
    <header className="border-b fixed inset-x-0 top-0 z-50 w-full bg-fd-background/80 backdrop-blur-md">
      <div className="grid h-16 w-full grid-cols-[auto_1fr_auto] items-center gap-4 px-6 font-normal lg:px-8">
        <div className="inline-flex items-center gap-3">
          <button
            type="button"
            aria-label="Open documentation sidebar"
            onClick={() => window.dispatchEvent(new Event(docsSidebarToggleEvent))}
            className="inline-flex size-9 items-center justify-center rounded-full border border-fd-border bg-fd-card text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground md:hidden"
          >
            <PanelLeft className="size-4" />
          </button>
          <Link href="/" className="inline-flex h-full shrink-0 items-center gap-2">
            <HeaderLogo />
            <span className="inline-flex items-center text-[23px] leading-none font-semibold tracking-tight text-black dark:text-white">
              {siteConfig.siteName}
            </span>
          </Link>
        </div>
        <div />
        <div className="flex items-center justify-self-end gap-[3rem] text-sm text-fd-muted-foreground">
          <Link
            href={siteConfig.mainSiteUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 font-normal transition-colors hover:text-fd-foreground"
          >
            <Navigation className="size-4" />
            App
          </Link>
          <Link
            href={siteConfig.githubUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 font-normal transition-colors hover:text-fd-foreground"
          >
            <Github className="size-4" />
            <span>GitHub</span>
          </Link>
          <SearchButton />
          <SearchButton compact />
          <ThemeButton />
        </div>
      </div>
    </header>
  );
}
