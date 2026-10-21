import { NextResponse } from 'next/server';
import { getProviderRouter, registeredProviders } from '@/server/ai/providers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/health/ai — which AI provider actually answers.
 *
 * Exists to disambiguate a specific failure that is otherwise very hard to
 * diagnose: a Bedrock inference-profile id sent to the direct Anthropic API
 * (or vice versa) fails with a validation error that looks exactly like a
 * missing credential. A ten-token round trip tells you which it is.
 */
export async function GET() {
  const providers = registeredProviders();

  if (providers.length === 0 || providers[0] === 'null') {
    return NextResponse.json(
      {
        ok: false,
        providers,
        error: 'No AI provider is configured. Set ANTHROPIC_API_KEY.',
      },
      { status: 503 },
    );
  }

  const started = Date.now();
  try {
    const router = getProviderRouter();
    const response = await router.route({
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 10,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    });

    const text = response.content.find((b) => b.type === 'text');
    return NextResponse.json({
      ok: true,
      providers,
      answeredBy: response.provider,
      latencyMs: Date.now() - started,
      reply: text && text.type === 'text' ? text.text.trim().slice(0, 40) : null,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        providers,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }
}
