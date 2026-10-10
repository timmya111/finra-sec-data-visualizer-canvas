import { describe, expect, it, vi } from 'vitest';

import {
	decreaseBackoffMs,
	fingerprintPayload,
	increaseBackoffMs,
	initialBackoffMs,
	payloadsDiffer,
	BACKOFF_FLOOR_MS,
	BACKOFF_MAX_MS,
	BACKOFF_MIN_MS,
} from '@/lib/selectionRefresh';
import {
	bumpSelectionRefreshGeneration,
	getSelectionRefreshGeneration,
	nodeKindAndId,
	scheduleSelectionExternalRefresh,
	setSelectionRefreshClientBackoffUntil,
	waitForSelectionAnimationSettle,
} from '@/lib/selectionRefreshClient';

describe('selectionRefresh fingerprints and backoff', () => {
	it('fingerprints ignore volatile timestamp fields', () => {
		const a = { name: 'Ada', lastCheckedAt: '2026-01-01', nested: { cachedAt: 1, value: 2 } };
		const b = { name: 'Ada', lastCheckedAt: '2026-02-02', nested: { cachedAt: 99, value: 2 } };
		expect(fingerprintPayload(a)).toBe(fingerprintPayload(b));
		expect(payloadsDiffer(a, { ...b, name: 'Bob' })).toBe(true);
		expect(payloadsDiffer(null, a)).toBe(true);
		expect(payloadsDiffer(a, null)).toBe(false);
	});

	it('initialBackoffMs stays in the 7–9 minute band', () => {
		expect(initialBackoffMs(() => 0)).toBe(BACKOFF_MIN_MS);
		expect(initialBackoffMs(() => 1)).toBe(BACKOFF_MAX_MS);
		const mid = initialBackoffMs(() => 0.5);
		expect(mid).toBeGreaterThanOrEqual(BACKOFF_MIN_MS);
		expect(mid).toBeLessThanOrEqual(BACKOFF_MAX_MS);
	});

	it('decreases backoff toward the floor after successful post-429 checks', () => {
		expect(decreaseBackoffMs(BACKOFF_MIN_MS)).toBe(BACKOFF_MIN_MS - 45_000);
		expect(decreaseBackoffMs(BACKOFF_FLOOR_MS)).toBe(BACKOFF_FLOOR_MS);
		expect(decreaseBackoffMs(BACKOFF_FLOOR_MS + 10_000, 45_000)).toBe(BACKOFF_FLOOR_MS);
	});

	it('increases backoff toward the 7–9 minute band on repeated 429s', () => {
		expect(increaseBackoffMs(BACKOFF_FLOOR_MS)).toBe(BACKOFF_MIN_MS);
		expect(increaseBackoffMs(BACKOFF_MAX_MS)).toBe(BACKOFF_MAX_MS);
		expect(increaseBackoffMs(BACKOFF_MIN_MS)).toBe(BACKOFF_MIN_MS + 45_000);
	});
});

describe('selectionRefreshClient scheduler', () => {
	it('parses person and firm node ids', () => {
		expect(nodeKindAndId({ id: 'person:1085996', group: 'individual' })).toEqual({ kind: 'individual', id: '1085996' });
		expect(nodeKindAndId({ id: 'firm:6363', group: 'firm' })).toEqual({ kind: 'firm', id: '6363' });
		expect(nodeKindAndId({ id: 'x', group: 'individual' })).toBeNull();
	});

	it('waitForSelectionAnimationSettle returns settled when alpha is low', async () => {
		const result = await waitForSelectionAnimationSettle({
			getAlpha: () => 0.01,
			isSimStopped: () => false,
			maxWaitMs: 500,
			pollMs: 20,
			extraDelayMs: 0,
			sleep: async () => undefined,
		});
		expect(result).toBe('settled');
	});

	it('waitForSelectionAnimationSettle times out when alpha stays hot', async () => {
		let t = 0;
		const result = await waitForSelectionAnimationSettle({
			getAlpha: () => 0.2,
			isSimStopped: () => false,
			maxWaitMs: 100,
			pollMs: 20,
			extraDelayMs: 0,
			now: () => {
				t += 40;
				return t;
			},
			sleep: async () => undefined,
		});
		expect(result).toBe('timeout');
	});

	it('scheduleSelectionExternalRefresh cancels when generation bumps', async () => {
		const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, updated: false }), { status: 200 }));
		const onUpdated = vi.fn();
		setSelectionRefreshClientBackoffUntil(0);
		scheduleSelectionExternalRefresh({
			node: { id: 'person:1', group: 'individual', crd: '1' },
			afterPromise: Promise.resolve(),
			getSelectedId: () => 'person:1',
			getAlpha: () => 0,
			isSimStopped: () => true,
			onUpdated,
			fetcher: fetcher as any,
			maxWaitMs: 200,
		});
		bumpSelectionRefreshGeneration();
		await new Promise((r) => setTimeout(r, 50));
		expect(fetcher).not.toHaveBeenCalled();
		expect(onUpdated).not.toHaveBeenCalled();
		expect(getSelectionRefreshGeneration()).toBeGreaterThan(0);
	});

	it('scheduleSelectionExternalRefresh posts after settle and applies updates', async () => {
		const fetcher = vi.fn(async () =>
			new Response(JSON.stringify({ ok: true, updated: true, detail: { basicInformation: { firstName: 'Ada' } } }), { status: 200 }),
		);
		const onUpdated = vi.fn();
		setSelectionRefreshClientBackoffUntil(0);
		scheduleSelectionExternalRefresh({
			node: { id: 'person:42', group: 'individual', crd: '42' },
			afterPromise: Promise.resolve(),
			getSelectedId: () => 'person:42',
			getAlpha: () => 0,
			isSimStopped: () => true,
			onUpdated,
			fetcher: fetcher as any,
			maxWaitMs: 100,
		});
		await new Promise((r) => setTimeout(r, 350));
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(onUpdated).toHaveBeenCalledTimes(1);
	});
});
