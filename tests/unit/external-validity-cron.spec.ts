import { describe, expect, it } from 'vitest';

import { rememberInventoryEntitiesDurable, resetCrdInventoryModuleCache } from '@/lib/crdInventorySidecar';
import {
	buildGapCandidates,
	buildNameQueryCandidates,
	detailCachePayload,
	extractCandidateIdsFromSearchPayload,
	filterValidFirmIds,
	resolveDiscoveryHighWater,
	shouldSkipCronRun,
} from '@/lib/externalValidityCron';
import { canCallExternalApis, setExternalApiContext } from '@/lib/externalApiGate';
import { makeRedisKey } from '@/lib/crd';

describe('externalValidityCron candidate discovery', () => {
	it('generates 3-10 character name terms from seed bank names', () => {
		const candidates = buildNameQueryCandidates(
			{
				individualIds: ['12345'],
				firmIds: ['67890'],
				nameByNumber: {
					individual: { '12345': 'Alicia Torres' },
					firm: { '67890': 'Northwind Capital' },
				},
			},
			50,
		);

		expect(candidates.some((term) => term.startsWith('alic'))).toBe(true);
		expect(candidates.some((term) => term.startsWith('torre'))).toBe(true);
		expect(candidates.some((term) => term.startsWith('north'))).toBe(true);
		expect(candidates.every((term) => term.length >= 3 && term.length <= 10)).toBe(true);
	});

	it('does not turn CRD IDs into name-search terms and caps the list', () => {
		const candidates = buildNameQueryCandidates(
			{
				individualIds: ['8354525', '011629', '007322'],
				firmIds: ['344865'],
				nameByNumber: {
					individual: { '1': 'Ada Lovelace' },
					firm: { '2': 'Beta Partners' },
				},
			},
			5,
		);
		expect(candidates.every((term) => !/^\d+$/.test(term))).toBe(true);
		expect(candidates.some((term) => term.includes('835') || term.includes('011') || term.includes('007'))).toBe(false);
		expect(candidates.length).toBeLessThanOrEqual(5);
		expect(candidates.some((term) => term.startsWith('ada') || term.startsWith('love') || term.startsWith('beta'))).toBe(true);
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

	it('buildGapCandidates can walk all the way to CRD 1', () => {
		const { candidates, nextCursor } = buildGapCandidates(4, new Set(['4', '2']), 5, 1);
		expect(candidates).toEqual(['3', '1']);
		expect(nextCursor).toBe(0);
	});

	it('detailCachePayload prefers raw hits envelopes and wraps parsed detail otherwise', () => {
		const raw = { hits: { hits: [{ _source: { content: { basicInformation: { firmId: '9' } } } }] } };
		expect(detailCachePayload(raw, { basicInformation: { firmId: '9' } }, 'content')).toBe(raw);

		const wrapped = detailCachePayload(null, { basicInformation: { firmName: 'Acme' } }, 'content') as any;
		expect(wrapped.hits.hits[0]._source.content.basicInformation.firmName).toBe('Acme');

		const iaWrapped = detailCachePayload(null, { basicInformation: { firstName: 'Ada' } }, 'iacontent') as any;
		expect(iaWrapped.hits.hits[0]._source.iacontent.basicInformation.firstName).toBe('Ada');
	});

	it('resolveDiscoveryHighWater floors from zset/inventory and ignores polluted firm IDs', () => {
		expect(
			resolveDiscoveryHighWater({
				seedIndividualMax: 100,
				seedFirmMax: 1_000_010,
				zsetIndividualMax: 8_354_489,
				zsetFirmMax: 344_829,
				inventoryIndividualMax: 8_335_647,
				inventoryFirmMax: 340_000,
			}),
		).toEqual({ individual: 8_354_489, firm: 344_829 });
		expect(filterValidFirmIds(['344829', '1000010', '12'])).toEqual(['344829', '12']);
	});

	it('cron detail keys stay bare (no query suffix)', () => {
		expect(makeRedisKey('finra', 'individual', '1085996')).toBe('finra:individual:1085996');
		expect(makeRedisKey('sec', 'firm', '8209')).toBe('sec:firm:8209');
	});

	it('ambient EXTERNAL_API_CONTEXT env does not bypass DISABLED; runtime context does', () => {
		const prevDisabled = process.env.EXTERNAL_API_DISABLED;
		const prevContext = process.env.EXTERNAL_API_CONTEXT;
		process.env.EXTERNAL_API_DISABLED = '1';
		process.env.EXTERNAL_API_CONTEXT = 'cronjob';
		setExternalApiContext(null);
		expect(canCallExternalApis()).toBe(false);
		setExternalApiContext('cronjob');
		expect(canCallExternalApis()).toBe(true);
		setExternalApiContext('selection-refresh');
		expect(canCallExternalApis()).toBe(true);
		setExternalApiContext(null);
		expect(canCallExternalApis()).toBe(false);
		if (prevDisabled == null) delete process.env.EXTERNAL_API_DISABLED;
		else process.env.EXTERNAL_API_DISABLED = prevDisabled;
		if (prevContext == null) delete process.env.EXTERNAL_API_CONTEXT;
		else process.env.EXTERNAL_API_CONTEXT = prevContext;
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
