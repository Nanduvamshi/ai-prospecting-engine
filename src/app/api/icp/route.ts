import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@/server/auth/require-auth';
import { getOrgICP, setOrgICP, validateICP } from '@/server/icp/store';

export const dynamic = 'force-dynamic';

// GET /api/crm/icp — fetch the calling user's org ICP (or null if unset).
export async function GET(request: NextRequest) {
  const { user, error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const icp = await getOrgICP(user.orgId);
    return NextResponse.json({ orgId: user.orgId, icp });
  } catch {
    return NextResponse.json({ error: 'Failed to load ICP' }, { status: 500 });
  }
}

// POST /api/crm/icp — upsert the org ICP.
// Body: CustomerICP shape (industries/titles/companySizes/geographies/useCases/customCriteria).
export async function POST(request: NextRequest) {
  const { user, error: authError } = await requireAuth(request);
  if (authError) return authErrorResponse(authError);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const raw = await request.json();
    // Accept both the bare ICP document and one wrapped as { icp: ... }.
    // Without this, a caller using the wrapped shape passes validation with
    // every field undefined and silently overwrites a real ICP with an empty
    // one — a quiet data loss that returns 200.
    const body = raw && typeof raw === 'object' && 'icp' in raw ? raw.icp : raw;

    const validation = validateICP(body);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    // Count populated fields, not keys: validateICP assigns `undefined` for
    // every field it did not find, so an all-undefined result still has keys.
    const populated = Object.values(validation.icp).filter((v) => v !== undefined).length;
    if (populated === 0) {
      return NextResponse.json(
        {
          error:
            'No recognised ICP fields were provided. Expected some of: industries, titles, companySizes, geographies, useCases, customCriteria.',
        },
        { status: 400 },
      );
    }
    await setOrgICP({ orgId: user.orgId, icp: validation.icp, updatedBy: user.sub });
    return NextResponse.json({ orgId: user.orgId, icp: validation.icp });
  } catch {
    return NextResponse.json({ error: 'Failed to save ICP' }, { status: 500 });
  }
}

// PUT is a natural verb for replacing the whole ICP document; accepting
// both avoids a confusing 405 depending on which the caller reaches for.
export const PUT = POST;
