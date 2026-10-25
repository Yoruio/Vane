import { preloadModel } from '@/lib/models/preload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Asks a provider to bring a model into memory. Called when the model is
 * chosen in the UI, so the load overlaps the user typing their question rather
 * than landing on the first model call of the search.
 *
 * Exists as a route because the provider's credentials must stay server-side.
 */
export const POST = async (req: Request) => {
  try {
    const body = (await req.json()) as { providerId?: string; key?: string };

    if (!body.providerId || !body.key) {
      return Response.json(
        { message: 'providerId and key are required' },
        { status: 400 },
      );
    }

    const result = await preloadModel(body.providerId, body.key);

    return Response.json(result, { status: 200 });
  } catch (err) {
    console.error('Failed to preload model:', err);
    return Response.json({ message: 'Preload failed' }, { status: 500 });
  }
};
