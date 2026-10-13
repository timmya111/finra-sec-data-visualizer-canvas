import { NextRequest, NextResponse } from 'next/server';
import { getExternalValidityCronStatus, runExternalValidityCron } from '@/lib/externalValidityCron';
import { setExternalApiContext } from '@/lib/externalApiGate';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

function isAuthorized(request: NextRequest) {
	const secret = process.env.CRON_SECRET;
	if (!secret) return true;
	const auth = request.headers.get('authorization');
	if (auth === `Bearer ${secret}`) return true;
	return request.headers.get('x-vercel-cron') === '1';
}

function wantsStatusOnly(request: NextRequest) {
	const value = request.nextUrl.searchParams.get('status');
	if (value == null) return false;
	const normalized = String(value).trim().toLowerCase();
	return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export async function GET(request: NextRequest) {
	if (!isAuthorized(request)) {
		return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
	}

	const noStore = {
		headers: {
			'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
		},
	};

	if (wantsStatusOnly(request)) {
		try {
			const status = await getExternalValidityCronStatus();
			return NextResponse.json(status, noStore);
		} catch (error: any) {
			return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: 500, ...noStore });
		}
	}

	try {
		setExternalApiContext('cronjob');
		try {
			const result = await runExternalValidityCron();
			return NextResponse.json(result, noStore);
		} finally {
			setExternalApiContext(null);
		}
	} catch (error: any) {
		return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: 500, ...noStore });
	}
}
