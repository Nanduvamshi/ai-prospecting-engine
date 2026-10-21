'use client';

import { useAuth } from '@/components/providers/AuthProvider';

/**
 * What the current user is allowed to do with prospects.
 *
 * A static role table rather than a permission matrix fetched from an API —
 * five permissions do not justify a network dependency on every page load.
 */

export type Permission =
  | 'prospects:view'
  | 'prospects:create'
  | 'prospects:edit'
  | 'prospects:delete'
  | 'prospects:research';

const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  super_admin: ['prospects:view', 'prospects:create', 'prospects:edit', 'prospects:delete', 'prospects:research'],
  admin: ['prospects:view', 'prospects:create', 'prospects:edit', 'prospects:delete', 'prospects:research'],
  manager: ['prospects:view', 'prospects:create', 'prospects:edit', 'prospects:research'],
  member: ['prospects:view', 'prospects:create', 'prospects:edit', 'prospects:research'],
  viewer: ['prospects:view'],
};

export function usePermissions() {
  const { user, loading } = useAuth();
  const granted = ROLE_PERMISSIONS[user?.role ?? 'member'] ?? ROLE_PERMISSIONS.member;

  return {
    loaded: !loading,
    can: (permission: Permission) => granted.includes(permission),
    permissions: granted,
  };
}
