import { NextRequest, NextResponse } from 'next/server';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Vercel functions are read-only except /tmp. Prefer /tmp there so client memory
// beacons do not 500 and pollute the console during graph sessions.
const LOG_DIR =
	process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
		? path.join('/tmp', 'finra-client-memory')
		: path.join(process.cwd(), '.local', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'client-memory.ndjson');

export async function POST(request: NextRequest) {
	try {
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') {
			return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 });
		}
		const entry = {
			ts: new Date().toISOString(),
			...body,
		};
		const usedMb = Number((body as any)?.jsHeapUsedMb);
		if (Number.isFinite(usedMb) && usedMb >= 1500) {
			console.warn(`[client-memory] jsHeapUsedMb=${usedMb} path=${(body as any)?.path || '?'}`);
		}
		try {
			await mkdir(LOG_DIR, { recursive: true });
			await appendFile(LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
		} catch (writeErr: any) {
			// Still acknowledge the beacon — disk write is best-effort telemetry.
			console.warn('[client-memory] write failed', writeErr?.message || writeErr);
			return NextResponse.json({ ok: true, persisted: false });
		}
		return NextResponse.json({ ok: true, persisted: true });
	} catch (err: any) {
		return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
	}
}
