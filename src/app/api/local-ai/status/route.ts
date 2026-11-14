import { NextResponse } from 'next/server';
import { rejectUnlessLocalAi } from '@/lib/localAi/guard';
import { DEFAULT_LOCAL_AI_MODEL, getOllamaBaseUrl, ollamaTags } from '@/lib/localAi/ollama';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
	const blocked = rejectUnlessLocalAi(request);
	if (blocked) return blocked;

	const baseUrl = getOllamaBaseUrl();
	const tags = await ollamaTags(baseUrl);
	return NextResponse.json(
		{
			ok: tags.ok,
			baseUrl,
			defaultModel: DEFAULT_LOCAL_AI_MODEL,
			models: tags.models,
			error: tags.error || null,
			localOnly: true,
		},
		{ headers: { 'Cache-Control': 'no-store' } },
	);
}
