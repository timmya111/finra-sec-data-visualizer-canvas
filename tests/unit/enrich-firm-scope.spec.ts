import { describe, expect, it, afterEach } from 'vitest';
import { clearSearchIndexCache, searchLocalIndex, searchLocalIndexMany } from '@/lib/localSearch';
import { searchHitLooksActive, searchHitLooksInactive } from '@/lib/searchHitActivity';

describe('firm ia scope enrichment', () => {
	afterEach(() => clearSearchIndexCache());

	it('enriches fisher active and dfj inactive via searchLocalIndex', async () => {
		const fisher = await searchLocalIndex('finra', 'firm', '107342', { limit: 5 });
		const fh =
			(fisher?.hits?.hits || []).find((h: any) => String(h._source?.firm_id) === '107342') || fisher?.hits?.hits?.[0];
		expect(fh?._source?.firm_ia_scope).toBe('ACTIVE');
		expect(searchHitLooksActive(fh, 'firm')).toBe(true);

		const dfj = await searchLocalIndex('sec', 'firm', '162462', { limit: 5 });
		const dh =
			(dfj?.hits?.hits || []).find((h: any) => String(h._source?.firm_id) === '162462') || dfj?.hits?.hits?.[0];
		expect(dh?._source?.firm_ia_scope).toBe('INACTIVE');
		expect(searchHitLooksInactive(dh, 'firm')).toBe(true);
		expect(searchHitLooksActive(dh, 'firm')).toBe(false);
	});

	it('enriches firm_ia_scope through searchLocalIndexMany (API path)', async () => {
		const many = await searchLocalIndexMany('finra', 'firm', 'fisher', { limit: 20 });
		const fisher = (many?.hits?.hits || []).find((h: any) => String(h._source?.firm_id) === '107342');
		expect(fisher?._source?.firm_ia_scope).toBe('ACTIVE');
		expect(searchHitLooksActive(fisher, 'firm')).toBe(true);

		const inactiveMany = await searchLocalIndexMany('sec', 'firm', 'dfj eplanet', { limit: 20 });
		const dfj = (inactiveMany?.hits?.hits || []).find((h: any) => String(h._source?.firm_id) === '162462');
		expect(dfj?._source?.firm_ia_scope).toBe('INACTIVE');
		expect(searchHitLooksInactive(dfj, 'firm')).toBe(true);
	});
});
