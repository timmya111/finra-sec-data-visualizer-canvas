import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRedis, setStringIfValid } = vi.hoisted(() => ({
	mockRedis: {
		get: vi.fn(),
		mget: vi.fn(),
		del: vi.fn(),
	},
	setStringIfValid: vi.fn(async () => 'written'),
}));

vi.mock('@/lib/redisCache', () => ({
	getRedisClient: () => mockRedis,
	setStringIfValid,
	decompressPayload: (value: string) => value,
}));

vi.mock('@/lib/firmEmploymentFromPrimed', () => ({
	lookupFirmEmploymentEdgesFromPrimed: vi.fn(async () => ({
		edges: [
			{
				personCrd: '821381',
				personName: 'FRANKLIN RUSSELL BEARD',
				isCurrent: false,
				startDate: '1/13/2001',
				endDate: '9/4/2002',
			},
		],
		source: 'bundle',
	})),
	getFirmEmploymentEdgesFromPrimed: vi.fn(async () => []),
}));

vi.mock('@/lib/officialFirmRoster', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/officialFirmRoster')>();
	return {
		...actual,
		fetchOfficialFirmRoster: vi.fn(async () => null),
	};
});

vi.mock('@/lib/localSearch', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/localSearch')>();
	return {
		...actual,
		lookupLocalSearchHitsByIds: vi.fn(async () => new Map()),
	};
});

import {
	composeIndividualDisplayName,
	connectionNeedsDisplayEnrichment,
	countFirmConnectionEntries,
	extractCurrentEmployerFromDetail,
	extractIndividualEmployerLinksFromDetail,
	firmConnectionsCacheKey,
	getFirmConnectionsFromGraph,
	mergeGraphConnectionEntries,
	preferRicherPersonName,
	upsertIndividualIntoEmployerFirmConnections,
} from '@/lib/graphConnections';
import { fetchOfficialFirmRoster, OFFICIAL_FIRM_ROSTER_SOURCE } from '@/lib/officialFirmRoster';

const fetchOfficialFirmRosterMock = vi.mocked(fetchOfficialFirmRoster);

describe('firm connection merge and cache', () => {
	beforeEach(() => {
		mockRedis.get.mockReset();
		mockRedis.mget.mockReset();
		mockRedis.del.mockReset();
		mockRedis.get.mockResolvedValue(null);
		mockRedis.mget.mockResolvedValue([]);
		setStringIfValid.mockClear();
		fetchOfficialFirmRosterMock.mockReset();
		fetchOfficialFirmRosterMock.mockResolvedValue(null);
		process.env.UPSTASH_ALLOW_WRITES = '1';
		delete process.env.REDIS_CACHE_ONLY;
	});

	it('builds the local firm cache key', () => {
		expect(firmConnectionsCacheKey('2525')).toBe('firm-connections:firm:2525');
	});

	it('extracts current and previous employer firm links from individual detail', () => {
		const links = extractIndividualEmployerLinksFromDetail({
			basicInformation: { firstName: 'Tim', lastName: 'Register' },
			currentEmployments: [{ firmId: 100, firmName: 'Current Firm', registrationBeginDate: '1/1/2020' }],
			previousEmployments: [
				{
					firmId: 7691,
					firmName: 'MERRILL LYNCH, PIERCE, FENNER & SMITH INCORPORATED',
					registrationBeginDate: '12/21/1982',
					registrationEndDate: '6/17/1983',
				},
			],
			previousIAEmployments: [{ firmId: 7691, firmName: 'Merrill', registrationBeginDate: '12/21/1982', registrationEndDate: '6/17/1983' }],
		});
		expect(links).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ firmId: '100', isCurrent: true }),
				expect.objectContaining({
					firmId: '7691',
					isCurrent: false,
					startDate: '12/21/1982',
					endDate: '6/17/1983',
					sources: expect.arrayContaining(['finra', 'sec']),
				}),
			]),
		);
	});

	it('lets current employment win when the same firm appears in previous too', () => {
		const links = extractIndividualEmployerLinksFromDetail({
			currentEmployments: [{ firmId: '50', firmName: 'Now', registrationBeginDate: '1/1/2024' }],
			previousEmployments: [{ firmId: '50', firmName: 'Then', registrationBeginDate: '1/1/2020', registrationEndDate: '12/31/2023' }],
		});
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({ firmId: '50', isCurrent: true });
		expect(links[0].endDate).toBeUndefined();
	});

	it('merges current and previous lists without dropping distinct people', () => {
		const merged = mergeGraphConnectionEntries([
			[{ individualId: '1', name: 'A', relationship: 'Current registration', isCurrent: true }],
			[
				{ individualId: '1', name: 'A', relationship: 'Current registration', isCurrent: true },
				{ individualId: '2', name: 'B', relationship: 'Previous registration', isCurrent: false },
			],
		]);
		expect(merged.currentConnections).toHaveLength(1);
		expect(merged.previousConnections).toHaveLength(1);
		expect(countFirmConnectionEntries(merged)).toBe(2);
	});

	it('returns empty when Redis and local disk firm-connections are both missing', async () => {
		mockRedis.get.mockResolvedValue(null);
		// Use a CRD that should not have data/firm-connections/{id}.json on disk.
		const result = await getFirmConnectionsFromGraph('900000999');
		expect(result).toEqual({ currentConnections: [], previousConnections: [] });
	});

	it('falls back to local disk firm-connections when Redis roster is missing', async () => {
		mockRedis.get.mockResolvedValue(null);
		const result = await getFirmConnectionsFromGraph('7691');
		expect(countFirmConnectionEntries(result)).toBeGreaterThan(0);
	});

	it('uses Redis firm-connections:firm as the only curated roster', async () => {
		mockRedis.get.mockImplementation(async (key: string) => {
			if (key === firmConnectionsCacheKey('2525')) {
				return JSON.stringify({
					currentConnections: [{ individualId: '999', name: 'Curated only', relationship: 'Current registration', isCurrent: true }],
					previousConnections: [],
				});
			}
			return null;
		});
		const result = await getFirmConnectionsFromGraph('2525');
		expect(result.currentConnections).toHaveLength(1);
		expect(result.currentConnections[0]).toMatchObject({ individualId: '999', name: 'Curated only' });
		expect(result.previousConnections).toHaveLength(0);
	});

	it('expands incomplete non-official Redis roster when computeIfMissing and writes only new CRDs', async () => {
		// Synthetic CRD (no data/firm-connections disk file). Mirrors thin prod-dashboard-api
		// snapshots like 127145 that must grow via official firm= search.
		const firmId = '900000127';
		mockRedis.get.mockImplementation(async (key: string) => {
			if (key === firmConnectionsCacheKey(firmId)) {
				return JSON.stringify({
					source: 'prod-dashboard-api',
					currentConnections: [
						{ individualId: '8248056', name: 'Jessica Lynn Facey', relationship: 'Current registration', isCurrent: true },
						{ individualId: '8354489', name: 'Antonio Joao Adao', relationship: 'Current registration', isCurrent: true },
					],
					previousConnections: [
						{ individualId: '10639', name: 'DONALD GLENN BAKER', relationship: 'Previous registration', isCurrent: false },
					],
				});
			}
			return null;
		});
		fetchOfficialFirmRosterMock.mockResolvedValue({
			source: OFFICIAL_FIRM_ROSTER_SOURCE,
			officialTotals: { finra: 2, sec: 4 },
			fetchedAt: '2026-04-01T00:00:00.000Z',
			currentConnections: [
				{ individualId: '8248056', name: 'Jessica Lynn Facey', relationship: 'Current registration', isCurrent: true },
				{ individualId: '9000001', name: 'New Current', relationship: 'Current registration', isCurrent: true },
			],
			previousConnections: [
				{ individualId: '10639', name: 'DONALD GLENN BAKER', relationship: 'Previous registration', isCurrent: false },
				{ individualId: '9000002', name: 'New Previous', relationship: 'Previous registration', isCurrent: false },
			],
		});

		const withoutBackfill = await getFirmConnectionsFromGraph(firmId, { skipEnrichment: true });
		expect(countFirmConnectionEntries(withoutBackfill)).toBe(3);
		expect(fetchOfficialFirmRosterMock).not.toHaveBeenCalled();

		setStringIfValid.mockClear();
		const withBackfill = await getFirmConnectionsFromGraph(firmId, {
			computeIfMissing: true,
			skipEnrichment: true,
		});
		expect(fetchOfficialFirmRosterMock).toHaveBeenCalledWith(firmId);
		// Official adds 9000001/9000002; existing 8354489 is kept (superset merge).
		expect(withBackfill.currentConnections.map((e) => e.individualId).sort()).toEqual([
			'8248056',
			'8354489',
			'9000001',
		]);
		expect(withBackfill.previousConnections.map((e) => e.individualId).sort()).toEqual([
			'10639',
			'9000002',
		]);
		expect(withBackfill.source).toBe(OFFICIAL_FIRM_ROSTER_SOURCE);
		expect(setStringIfValid).toHaveBeenCalled();
		const written = JSON.parse(setStringIfValid.mock.calls[0][1]);
		expect(written.source).toBe(OFFICIAL_FIRM_ROSTER_SOURCE);
		expect(countFirmConnectionEntries(written)).toBe(5);
	});

	it('skips official expand when Redis roster is already official-search', async () => {
		const firmId = '900000128';
		mockRedis.get.mockImplementation(async (key: string) => {
			if (key === firmConnectionsCacheKey(firmId)) {
				return JSON.stringify({
					source: OFFICIAL_FIRM_ROSTER_SOURCE,
					officialTotals: { finra: 1, sec: 1 },
					currentConnections: [
						{ individualId: '1', name: 'Already Official', relationship: 'Current registration', isCurrent: true },
					],
					previousConnections: [],
				});
			}
			return null;
		});
		const result = await getFirmConnectionsFromGraph(firmId, {
			computeIfMissing: true,
			skipEnrichment: true,
		});
		expect(result.currentConnections).toHaveLength(1);
		expect(fetchOfficialFirmRosterMock).not.toHaveBeenCalled();
		expect(setStringIfValid).not.toHaveBeenCalled();
	});

	it('hydrates Redis CRD arrays into connection entries', async () => {
		mockRedis.get.mockImplementation(async (key: string) => {
			if (key === firmConnectionsCacheKey('900000001')) {
				return JSON.stringify({
					current: [42, '43'],
					previous: ['44'],
				});
			}
			return null;
		});

		const result = await getFirmConnectionsFromGraph('900000001');
		expect(result.currentConnections.map((entry) => entry.individualId).sort()).toEqual(['42', '43']);
		expect(result.previousConnections.map((entry) => entry.individualId)).toEqual(['44']);
	});

	it('adds a person from employment history without shrinking Redis roster', async () => {
		const existing = {
			currentConnections: Array.from({ length: 5 }, (_, i) => ({
				individualId: String(100 + i),
				name: `P${i}`,
				relationship: 'Current registration',
				isCurrent: true,
			})),
			previousConnections: [{ individualId: '200', name: 'Prev', relationship: 'Previous registration', isCurrent: false }],
		};
		mockRedis.get.mockImplementation(async (key: string) => {
			if (key === firmConnectionsCacheKey('7691')) return JSON.stringify(existing);
			return null;
		});
		setStringIfValid.mockClear();
		const result = await upsertIndividualIntoEmployerFirmConnections('1085996', {
			basicInformation: { firstName: 'Timothy', lastName: 'Register' },
			previousEmployments: [
				{
					firmId: '7691',
					firmName: 'Merrill',
					registrationBeginDate: '12/21/1982',
					registrationEndDate: '6/17/1983',
				},
			],
		});
		expect(result.firmsTouched).toEqual(['7691']);
		expect(setStringIfValid).toHaveBeenCalledTimes(1);
		const written = JSON.parse(setStringIfValid.mock.calls[0][1]);
		expect(written.currentConnections).toHaveLength(5);
		expect(written.previousConnections.map((e: { individualId: string }) => e.individualId)).toEqual(
			expect.arrayContaining(['200', '1085996']),
		);
		const upserted = written.previousConnections.find((e: { individualId: string }) => e.individualId === '1085996');
		expect(upserted.name).toBe('Timothy Register');
	});

	it('composes full person names and upgrades thin connection names', () => {
		expect(
			composeIndividualDisplayName({
				basicInformation: { firstName: 'Susan', middleName: 'F', lastName: 'Axelrod' },
			}),
		).toBe('Susan F Axelrod');
		expect(preferRicherPersonName('Susan', 'Susan F Axelrod')).toBe('Susan F Axelrod');
		expect(preferRicherPersonName('Susan F Axelrod', 'Susan')).toBe('Susan F Axelrod');
		expect(connectionNeedsDisplayEnrichment({ individualId: '1', name: 'Susan', relationship: 'Current registration', isCurrent: true })).toBe(true);
		expect(
			connectionNeedsDisplayEnrichment({
				individualId: '1',
				name: 'Susan F Axelrod',
				address: 'LAS VEGAS, NV 89145',
				relationship: 'Current registration',
				isCurrent: true,
			}),
		).toBe(false);
		expect(
			connectionNeedsDisplayEnrichment({
				individualId: '1',
				name: 'Matthew Joseph McGowan',
				address: 'NEW YORK, NY',
				relationship: 'Previous registration',
				isCurrent: false,
			}),
		).toBe(false);
		expect(
			extractCurrentEmployerFromDetail(
				{
					currentEmployments: [
						{ firmId: '7691', firmName: 'Merrill' },
						{ firmId: '283942', firmName: 'BOFA SECURITIES, INC.' },
					],
				},
				'7691',
			),
		).toEqual({ currentFirmId: '283942', currentFirmName: 'BOFA SECURITIES, INC.' });
	});

	it('enriches thin Redis connection display fields from cached individual details', async () => {
		const finraDetailJson = JSON.stringify({
			hits: {
				hits: [
					{
						_source: {
							content: JSON.stringify({
								basicInformation: { firstName: 'Susan', middleName: 'F', lastName: 'Axelrod', bcScope: 'Active' },
								currentEmployments: [
									{
										firmId: '7691',
										branchOfficeLocations: [{ street1: '400 S RAMPART BLVD', city: 'LAS VEGAS', state: 'NV', zipCode: '89145' }],
									},
								],
							}),
						},
					},
				],
			},
		});
		mockRedis.get.mockImplementation(async (key: string) => {
			if (key === firmConnectionsCacheKey('7691')) {
				return JSON.stringify({
					currentConnections: [
						{
							individualId: '6949587',
							name: 'Susan',
							relationship: 'Current registration',
							isCurrent: true,
							evidence: ['individual-detail-load'],
						},
					],
					previousConnections: [],
				});
			}
			if (key === 'finra:individual:6949587') {
				return finraDetailJson;
			}
			return null;
		});
		// Enrichment now batches per-source lookups via mget instead of one get() per entry.
		mockRedis.mget.mockImplementation(async (...keys: string[]) => {
			return keys.map((key) => (key === 'finra:individual:6949587' ? finraDetailJson : null));
		});
		setStringIfValid.mockClear();
		const result = await getFirmConnectionsFromGraph('7691');
		expect(result.currentConnections[0]).toMatchObject({
			individualId: '6949587',
			name: 'Susan F Axelrod',
		});
		expect(String(result.currentConnections[0].address || '')).toMatch(/LAS VEGAS/i);
		expect(setStringIfValid).toHaveBeenCalled();
	});

	it('adds a FINRA-only person to an empty SEC-only firm roster and skips rewrite when CRD already present', async () => {
		// DFJ Gotham Management CRD 330745 — SEC-only IA firm; firm= search is empty, so
		// roster growth comes from individual detail loads (including FINRA BD employment).
		const firmId = '330745';
		let roster: any = { currentConnections: [], previousConnections: [] };
		mockRedis.get.mockImplementation(async (key: string) => {
			if (key === firmConnectionsCacheKey(firmId)) return JSON.stringify(roster);
			return null;
		});
		mockRedis.del.mockClear();
		setStringIfValid.mockImplementation(async (key: string, raw: string) => {
			if (key === firmConnectionsCacheKey(firmId)) {
				roster = JSON.parse(raw);
			}
			return 'written';
		});

		const finraOnlyDetail = {
			basicInformation: { firstName: 'Alex', lastName: 'Broker', bcScope: 'Active' },
			bcScope: 'Active',
			// No IA employments — FINRA-only individual with BD history at an SEC-only firm.
			previousEmployments: [
				{
					firmId,
					firmName: 'DRAPER FISHER JURVETSON GOTHAM MANAGEMENT, LLC',
					registrationBeginDate: '3/1/2018',
					registrationEndDate: '6/30/2019',
				},
			],
		};

		const first = await upsertIndividualIntoEmployerFirmConnections('9000001', finraOnlyDetail);
		expect(first.firmsTouched).toEqual([firmId]);
		expect(first.firmsSkippedUnchanged).toEqual([]);
		expect(roster.previousConnections).toEqual([
			expect.objectContaining({
				individualId: '9000001',
				name: 'Alex Broker',
				isCurrent: false,
			}),
		]);
		expect(mockRedis.del).toHaveBeenCalledWith(`${firmConnectionsCacheKey(firmId)}:empty`);

		setStringIfValid.mockClear();
		mockRedis.del.mockClear();
		const second = await upsertIndividualIntoEmployerFirmConnections('9000001', {
			...finraOnlyDetail,
			basicInformation: { firstName: 'Alexander', lastName: 'Broker', bcScope: 'Active' },
		});
		expect(second.firmsTouched).toEqual([]);
		expect(second.firmsSkippedUnchanged).toEqual([firmId]);
		expect(setStringIfValid).not.toHaveBeenCalled();
		// Name stays as first write — page-load does not rewrite for existing CRDs.
		expect(roster.previousConnections[0].name).toBe('Alex Broker');
	});

	it('stores current employer on previous-firm upserts', async () => {
		mockRedis.get.mockImplementation(async (key: string) => {
			if (key === firmConnectionsCacheKey('7691')) {
				return JSON.stringify({ currentConnections: [], previousConnections: [] });
			}
			return null;
		});
		setStringIfValid.mockClear();
		await upsertIndividualIntoEmployerFirmConnections('2266159', {
			basicInformation: { firstName: 'Matthew', middleName: 'Joseph', lastName: 'McGowan' },
			currentEmployments: [{ firmId: '283942', firmName: 'BOFA SECURITIES, INC.' }],
			previousEmployments: [
				{
					firmId: '7691',
					firmName: 'Merrill',
					registrationBeginDate: '1/1/2010',
					registrationEndDate: '1/1/2015',
				},
			],
		});
		expect(setStringIfValid).toHaveBeenCalled();
		const previousWrite = setStringIfValid.mock.calls
			.map((call: unknown[]) => {
				try {
					return JSON.parse(String(call[1] || ''));
				} catch {
					return null;
				}
			})
			.find((payload: any) => payload?.previousConnections?.some((entry: any) => entry.individualId === '2266159'));
		expect(previousWrite?.previousConnections?.[0]).toMatchObject({
			individualId: '2266159',
			name: 'Matthew Joseph McGowan',
			currentFirmId: '283942',
			currentFirmName: 'BOFA SECURITIES, INC.',
		});
	});
});
