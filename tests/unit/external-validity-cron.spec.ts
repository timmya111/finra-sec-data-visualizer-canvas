import { describe, expect, it } from 'vitest';

import { rememberInventoryEntitiesDurable, resetCrdInventoryModuleCache } from '@/lib/crdInventorySidecar';
import {
	buildGapCandidates,
	buildNameQueryCandidates,
	extractCandidateIdsFromSearchPayload,
	shouldSkipCronRun,
} from '@/lib/externalValidityCron';

describe('externalValidityCron candidate discovery', () => {
	it('generates 3-10 character name terms from seed bank names', () => {
		const candidates = buildNameQueryCandidates({
			individualIds: ['12345'],
			firmIds: ['67890'],
			nameByNumber: {
				individual: { '12345': 'Alicia Torres' },
				firm: { '67890': 'Northwind Capital' },
			},
		});

		expect(candidates.some((term) => term === 'alic')).toBe(true);
		expect(candidates.some((term) => term === 'torre')).toBe(true);
		expect(candidates.some((term) => term === 'north')).toBe(true);
		expect(candidates.every((term) => term.length >= 3 && term.length <= 10)).toBe(true);
	});

	it('pulls numeric CRD/Firm IDs out of search payload hits', () => {
		const payload = {
			hits: {
				hits: [
					{
						_source: {
							ind_source_id: '12345',
							content: { basicInformation: { crd: '12345' } },
						},
					},
					{
						_source: {
							firm_id: '67890',
							content: { basicInformation: { firmId: '67890' } },
						},
					},
				],
			},
		};

		expect(extractCandidateIdsFromSearchPayload(payload, 'individual')).toEqual(['12345']);
		expect(extractCandidateIdsFromSearchPayload(payload, 'firm')).toEqual(['67890']);
	});

	it('skips cron runs that are still inside the cooldown window', () => {
		const lastRunAt = new Date('2026-07-26T00:00:00.000Z').toISOString();
		expect(shouldSkipCronRun(lastRunAt, Date.parse('2026-07-26T03:00:00.000Z'), 360)).toBe(true);
		expect(shouldSkipCronRun(lastRunAt, Date.parse('2026-07-26T08:00:00.000Z'), 360)).toBe(false);
	});

	it('buildGapCandidates walks backward and skips known CRDs', () => {
		const known = new Set(['100', '98', '95']);
		const { candidates, nextCursor } = buildGapCandidates(100, known, 3, 90);
		expect(candidates).toEqual(['99', '97', '96']);
		// Cursor sits on the next number to inspect (95 is known and will be skipped next run).
		expect(nextCursor).toBe(95);
	});

	it('buildGapCandidates stops at the floor without probing known IDs', () => {
		const { candidates, nextCursor } = buildGapCandidates(5, new Set(['5', '4', '3']), 5, 3);
		expect(candidates).toEqual([]);
		expect(nextCursor).toBe(2);
	});

	it('rememberInventoryEntitiesDurable bumps Redis when new CRDs are added', async () => {
		const prevPath = process.env.CRD_INVENTORY_PATH;
		const prevVercel = process.env.VERCEL;
		process.env.CRD_INVENTORY_PATH = `/tmp/crd-inventory-test-${Date.now()}.json.gz`;
		process.env.VERCEL = '1'; // skip durable disk writes in the test isolate
		resetCrdInventoryModuleCache();
		try {
			const calls: Array<{ op: string; args: unknown[] }> = [];
			const redis = {
				get: async (key: string) => {
					calls.push({ op: 'get', args: [key] });
					return '10';
				},
				set: async (key: string, value: string | number) => {
					calls.push({ op: 'set', args: [key, value] });
					return 'OK';
				},
				incrby: async (key: string, amount: number) => {
					calls.push({ op: 'incrby', args: [key, amount] });
					return 11;
				},
				del: async (key: string) => {
					calls.push({ op: 'del', args: [key] });
					return 1;
				},
				zadd: async (key: string, opts: { score: number; member: string }) => {
					calls.push({ op: 'zadd', args: [key, opts] });
					return 1;
				},
			};

			const result = await rememberInventoryEntitiesDurable([{ kind: 'individual', id: 9990001 }], redis);
			expect(result.added).toBe(1);
			expect(result.redisCount).toBe(11);
			expect(calls.some((c) => c.op === 'incrby' && c.args[1] === 1)).toBe(true);
			expect(calls.some((c) => c.op === 'zadd' && String(c.args[0]).includes('individual'))).toBe(true);
		} finally {
			if (prevPath == null) delete process.env.CRD_INVENTORY_PATH;
			else process.env.CRD_INVENTORY_PATH = prevPath;
			if (prevVercel == null) delete process.env.VERCEL;
			else process.env.VERCEL = prevVercel;
			resetCrdInventoryModuleCache();
		}
	});
});
