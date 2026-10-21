import { AuthProvider } from '@/components/providers/AuthProvider';
import { AppShell } from '@/components/shell/AppShell';

/**
 * Authenticated area.
 *
 * Two providers and nothing else at the root. Every global provider is a cost
 * every page pays, so only what prospecting actually needs lives here.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AppShell>{children}</AppShell>
    </AuthProvider>
  );
}
