'use client';

import { useAuth } from '@/components/providers/AuthProvider';

/**
 * Which slice of the org's data the current user sees.
 *
 * Scoping is enforced server-side — every query is org-filtered, and owner
 * filtering is an explicit query parameter — so this only supplies the label
 * the header shows.
 */

export type VisibilityScope = 'org' | 'team' | 'mine';

const LABELS: Record<VisibilityScope, string> = {
  org: 'All prospects',
  team: 'My team',
  mine: 'My prospects',
};

export function useDataVisibility(): { scope: VisibilityScope; badgeLabel: string } {
  const { user } = useAuth();
  const role = user?.role ?? 'member';
  const scope: VisibilityScope =
    role === 'admin' || role === 'super_admin' ? 'org' : role === 'manager' ? 'team' : 'mine';

  return { scope, badgeLabel: LABELS[scope] };
}
