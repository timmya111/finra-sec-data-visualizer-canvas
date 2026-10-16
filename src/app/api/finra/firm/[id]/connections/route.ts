import { NextRequest, NextResponse } from 'next/server';
import { FIRM_CONNECTIONS_HTTP_CACHE_SECONDS, getFirmConnectionsFromGraph } from '@/lib/graphConnections';
import { sharedCacheHeaders } from '@/lib/httpCache';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
// Cold reverse-index build can exceed default budget; precomputed adj keeps this fast.
export const maxDuration = 60;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!/^\d{1,10}$/.test(id)) {
		return NextResponse.json({ error: 'Invalid firm ID.' }, { status: 400 });
	}

	try {
		const bucket = String(request.nextUrl.searchParams.get('bucket') || 'all').trim().toLowerCase();
		// Always skip sidecar/Redis individual enrichment on this route. Enrichment gunzips
		// search indexes and mgets individuals — that 504/OOMs on Vercel (127145 non-light).
		// Dashboard already calls ?light=1; names/scopes come from the cached roster itself.
		const light = true;
		// Redis/disk miss schedules official firm= backfill in the background (empty → no-store).
		// Incomplete non-official rosters are expanded from firm detail ensure, not here.
		const { currentConnections, previousConnections } = await getFirmConnectionsFromGraph(id, {
			skipEnrichment: true,
			computeIfMissing: true,
		});
		const current = bucket === 'previous' ? [] : currentConnections || [];
		const previous = bucket === 'current' ? [] : previousConnections || [];
		const entryCount = (current?.length || 0) + (previous?.length || 0);
		// Empty rosters must not sit on the CDN for a week — that blocked SEC-only firm
		// canvas expand after a transient Redis/official-search miss (e.g. 119682 / 107342).
		const headers =
			entryCount > 0 ?
				sharedCacheHeaders(FIRM_CONNECTIONS_HTTP_CACHE_SECONDS, FIRM_CONNECTIONS_HTTP_CACHE_SECONDS)
			:	{ 'Cache-Control': 'no-store' };

		return NextResponse.json(
			{
				firmId: id,
				found: true,
				currentConnections: current,
				previousConnections: previous,
				...(light ? { light: true } : {}),
			},
			{ headers },
		);
	} catch (err: any) {
		logger.warn('Failed to load firm connections from graph route', { id, error: err?.message || String(err) });
		return NextResponse.json(
			{
				firmId: id,
				found: false,
				currentConnections: [],
				previousConnections: [],
				error: err?.message || String(err),
			},
			{ status: 200, headers: { 'Cache-Control': 'no-store' } },
		);
	}
}
