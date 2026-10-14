import { describe, it, expect } from 'vitest';
import { searchLocalIndex, searchLocalIndexMany, clearSearchIndexCache } from '@/lib/localSearch';

describe('surname search pagination totals', () => {
	it('returns unique noble hits and a stable total across page sizes', async () => {
		clearSearchIndexCache();
		const full = await searchLocalIndexMany('finra', 'individual', 'noble', { limit: 1000 });
		const page = await searchLocalIndexMany('finra', 'individual', 'noble', { limit: 100 });
		const indexPage = await searchLocalIndex('finra', 'individual', 'noble', { limit: 100 });

		const pageIds = page.results.map((d: any) => String(d?.ind_source_id || d?.id || ''));
		const uniquePageIds = new Set(pageIds);

		expect(full.total).toBeGreaterThan(80);
		expect(page.total).toBe(full.total);
		expect(indexPage.total).toBe(full.total);
		expect(page.results.length).toBe(Math.min(100, full.total));
		expect(uniquePageIds.size).toBe(page.results.length);
		expect(page.total).toBeGreaterThan(page.results.length === 100 ? 100 : 0);
	}, 120000);

	it('returns unique hopper hits with uncapped total at rows=100', async () => {
		clearSearchIndexCache();
		const full = await searchLocalIndexMany('finra', 'individual', 'hopper', { limit: 1000 });
		const page = await searchLocalIndexMany('finra', 'individual', 'hopper', { limit: 100 });

		expect(full.total).toBeGreaterThan(70);
		expect(page.total).toBe(full.total);
		expect(page.results.length).toBe(Math.min(100, full.total));
		expect(new Set(page.results.map((d: any) => d?.ind_source_id || d?.id)).size).toBe(page.results.length);
	}, 120000);
});
