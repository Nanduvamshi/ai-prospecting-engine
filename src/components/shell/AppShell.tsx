'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Target,
  ChartLineUp,
  PaperPlaneTilt,
  Gear,
  Sun,
  Moon,
  SidebarSimple,
  SignOut,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { useTheme } from '@/components/providers/ThemeProvider';
import { useAuth } from '@/components/providers/AuthProvider';
import { useDataVisibility } from '@/hooks/useDataVisibility';

/**
 * Application chrome.
 *
 * Replaces a layout that carried an eight-tab CRM navigation, a breadcrumb
 * bar, a copilot mount, a global email composer, and three on-mount service
 * initialisers for lead assignment, sequence running and churn alerts — none
 * of which belong to a prospecting product. Sequence running in particular is
 * now a server cron, which is where it should always have been.
 *
 * The sidebar widths are fixed at 72 / 256 pixels because the page
 * components have breakpoint assumptions baked around them.
 */

const NAV = [
  { href: '/leads', label: 'Leads', icon: Target },
  { href: '/signals', label: 'Signals', icon: ChartLineUp },
  { href: '/sequences', label: 'Sequences', icon: PaperPlaneTilt },
  { href: '/settings', label: 'Settings', icon: Gear },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();
  const { user, signOut } = useAuth();
  const { badgeLabel } = useDataVisibility();
  const [collapsed, setCollapsed] = useState(false);

  const isDark = theme === 'dark';
  const width = collapsed ? 72 : 256;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex flex-col border-r border-border bg-card',
          'transition-[width] duration-200 ease-out',
        )}
        style={{ width }}
      >
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <Target size={22} weight="duotone" className="shrink-0 text-primary" />
          {!collapsed && <span className="font-heading text-sm font-semibold">Prospecting</span>}
        </div>

        <nav className="flex-1 space-y-1 p-2">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                title={collapsed ? label : undefined}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon size={20} weight={active ? 'duotone' : 'regular'} className="shrink-0" />
                {!collapsed && <span>{label}</span>}
              </Link>
            );
          })}
        </nav>

        <div className="space-y-1 border-t border-border p-2">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <SidebarSimple size={20} className="shrink-0" />
            {!collapsed && <span>Collapse</span>}
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Toggle theme"
          >
            {isDark ? <Sun size={20} className="shrink-0" /> : <Moon size={20} className="shrink-0" />}
            {!collapsed && <span>{isDark ? 'Light mode' : 'Dark mode'}</span>}
          </button>
        </div>
      </aside>

      <div style={{ marginLeft: width }} className="transition-[margin] duration-200 ease-out">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-background/80 px-6 backdrop-blur">
          <span className="text-xs text-muted-foreground">{badgeLabel}</span>
          <div className="flex items-center gap-3">
            {user && (
              <>
                <div className="text-right leading-tight">
                  <div className="text-sm font-medium">{user.name}</div>
                  <div className="text-xs capitalize text-muted-foreground">{user.role}</div>
                </div>
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-sm font-medium text-primary">
                  {user.name.charAt(0).toUpperCase()}
                </div>
                <button
                  type="button"
                  onClick={signOut}
                  title="Sign out"
                  aria-label="Sign out"
                  className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <SignOut size={18} />
                </button>
              </>
            )}
          </div>
        </header>

        <main className="p-6">{children}</main>
      </div>
    </div>
  );
}
