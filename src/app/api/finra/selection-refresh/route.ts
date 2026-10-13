import { NextRequest, NextResponse } from 'next/server';
import { setExternalApiContext } from '@/lib/externalApiGate';
import { runSelectionRefresh, type SelectionRefreshKind } from '@/lib/selectionRefresh';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

function isAuthorized(request: NextRequest) {
	const secret = process.env.CRON_SECRET;
	if (!secret) return true;
	const auth = request.headers.get('authorization');
	if (auth === `Bearer ${secret}`) return true;
	// Same-origin browser POSTs from the graph UI (no cron header).
	const origin = request.headers.get('origin');
	const host = request.headers.get('host');
	if (origin && host) {
		try {
			const originHost = new URL(origin).host;
			if (originHost === host) return true;
		} catch {
			/* ignore */
		}
	}
	return request.headers.get('x-vercel-cron') === '1';
}

function parseBody(body: any): { kind: SelectionRefreshKind; id: string } | null {
	const kindRaw = String(body?.kind || body?.type || '').trim().toLowerCase();
	const kind: SelectionRefreshKind | null =
		kindRaw === 'individual' || kindRaw === 'person' ? 'individual'
		: kindRaw === 'firm' ? 'firm'
		:	null;
	const id = String(body?.id || body?.crd || '')
		.trim()
		.replace(/^(person|individual|firm)[:_]/i, '');
	if (!kind || !/^\d+$/.test(id)) return null;
	return { kind, id };
}

export async function POST(request: NextRequest) {
	if (!isAuthorized(request)) {
		return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
	}

	let body: any = null;
	try {
		body = await request.json();
	} catch {
		body = null;
	}
	const parsed = parseBody(body);
	if (!parsed) {
		return NextResponse.json({ ok: false, skipped: 'invalid', error: 'Expected { kind, id }' }, { status: 400 });
	}

	setExternalApiContext('selection-refresh');
	try {
		const result = await runSelectionRefresh(parsed.kind, parsed.id);
		const status = result.ok ? 200 : result.skipped === 'no-redis' ? 503 : 500;
		return NextResponse.json(result, {
			status,
			headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' },
		});
	} catch (error: any) {
		return NextResponse.json(
			{ ok: false, error: String(error?.message || error) },
			{ status: 500, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' } },
		);
	} finally {
		setExternalApiContext(null);
	}
}
