import { NextResponse } from 'next/server';
import { runLocalAiAgent } from '@/lib/localAi/agent';
import { rejectUnlessLocalAi } from '@/lib/localAi/guard';
import { LOCAL_AI_AUTO_MODEL } from '@/lib/localAi/orchestrator';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request: Request) {
	const blocked = rejectUnlessLocalAi(request);
	if (blocked) return blocked;

	let body: any = null;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
	}

	const question = String(body?.question || body?.message || '').trim();
	if (!question) {
		return NextResponse.json({ error: 'question required' }, { status: 400 });
	}

	const model = String(body?.model || LOCAL_AI_AUTO_MODEL).trim() || LOCAL_AI_AUTO_MODEL;
	const history = Array.isArray(body?.history) ? body.history : [];
	const aboutNodeGraph = Boolean(body?.aboutNodeGraph);
	const canvasSnapshot =
		aboutNodeGraph && body?.canvasSnapshot && typeof body.canvasSnapshot === 'object' ? body.canvasSnapshot : null;
	const availableModels = Array.isArray(body?.availableModels) ?
		body.availableModels.map((m: unknown) => String(m || '').trim()).filter(Boolean)
	:	undefined;

	const result = await runLocalAiAgent({
		question,
		model,
		history,
		canvasSnapshot,
		aboutNodeGraph,
		availableModels,
	});
	return NextResponse.json(result, {
		status: result.ok ? 200 : 500,
		headers: { 'Cache-Control': 'no-store' },
	});
}
