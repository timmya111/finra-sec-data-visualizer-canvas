import { expect, test, type Page } from '@playwright/test';

import { resetBrowserGraphState } from './helpers/finra-e2e';
import {
	clearGraphSearchClickConfig,
	graphNodeLabels,
	setLegacyHeaderSearchType,
} from './helpers/search-click-config';

const INDIVIDUAL_HIT = {
	_source: {
		ind_source_id: '9999001',
		ind_crd: '9999001',
		ind_firstname: 'Toggle',
		ind_middlename: '',
		ind_lastname: 'Person',
		ind_bc_scope: 'Active',
	},
};

const INACTIVE_INDIVIDUAL_HIT = {
	_source: {
		ind_source_id: '9999003',
		ind_crd: '9999003',
		ind_firstname: 'Inactive',
		ind_middlename: '',
		ind_lastname: 'Person',
		ind_bc_scope: 'InActive',
		ind_ia_scope: 'InActive',
	},
};

const FIRM_HIT = {
	_source: {
		firm_id: '9999002',
		firm_source_id: '9999002',
		firm_name: 'Toggle Firm Inc',
		firm_bc_scope: 'ACTIVE',
	},
};

const INACTIVE_FIRM_HIT = {
	_source: {
		firm_id: '9999004',
		firm_source_id: '9999004',
		firm_name: 'Inactive Firm Inc',
		firm_bc_scope: 'INACTIVE',
	},
};

async function mockSearchEndpoints(page: Page) {
	await page.route('**/api/finra/search**', async (route) => {
		const url = new URL(route.request().url());
		const isFirmRequest = url.searchParams.get('firm') === '1';
		const hits = isFirmRequest ? [FIRM_HIT, INACTIVE_FIRM_HIT] : [INDIVIDUAL_HIT, INACTIVE_INDIVIDUAL_HIT];
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				hits: {
					total: hits.length,
					hits,
				},
				results: hits.map((hit) => hit._source),
				total: hits.length,
			}),
		});
	});

	await page.route('**/api/finra/sec-search**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ hits: { total: 0, hits: [] }, results: [], total: 0 }),
		});
	});

	// People text hits stay off-canvas until detail hydration; stub individual fetches.
	await page.route('**/api/finra/individual/**', async (route) => {
		const crd = decodeURIComponent(route.request().url().split('/').pop() || '').split('?')[0];
		const hit =
			crd === '9999001' ? INDIVIDUAL_HIT._source
			: crd === '9999003' ? INACTIVE_INDIVIDUAL_HIT._source
			: null;
		if (!hit) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ found: false }),
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				found: true,
				basicInformation: {
					individualId: hit.ind_source_id || hit.ind_crd,
					firstName: hit.ind_firstname,
					middleName: hit.ind_middlename,
					lastName: hit.ind_lastname,
					bcScope: hit.ind_bc_scope,
					iaScope: hit.ind_ia_scope,
				},
				ind_source_id: hit.ind_source_id,
				ind_crd: hit.ind_crd,
				ind_firstname: hit.ind_firstname,
				ind_middlename: hit.ind_middlename,
				ind_lastname: hit.ind_lastname,
				ind_bc_scope: hit.ind_bc_scope,
				ind_ia_scope: hit.ind_ia_scope,
				currentEmployments: [],
				previousEmployments: [],
			}),
		});
	});
}

async function runHeaderSearch(
	page: Page,
	query: string,
	type: 'all' | 'people' | 'firms' | 'people-inactive' | 'firms-inactive',
) {
	await setLegacyHeaderSearchType(page, type);
	const fetchInput = page.locator('#fg-fetch-input');
	await fetchInput.fill(query);
	await page.locator('#fg-database-search').click();
	await expect(page.locator('#fg-database-search')).toBeEnabled({ timeout: 10_000 });
}

async function waitForGraphLabel(page: Page, label: string) {
	await expect
		.poll(
			async () => {
				const nodes = await graphNodeLabels(page);
				return nodes.some((node) => node.label.includes(label)) ? 1 : 0;
			},
			{
				timeout: 10_000,
				message: `expected graph node label containing ${label}`,
			},
		)
		.toBe(1);
}

async function countGraphLabels(page: Page, label: string) {
	const nodes = await graphNodeLabels(page);
	return nodes.filter((node) => node.label.includes(label)).length;
}

async function countGraphGroup(page: Page, group: 'individual' | 'firm') {
	const nodes = await graphNodeLabels(page);
	return nodes.filter((node) => node.group === group || node.id.startsWith(group === 'firm' ? 'firm:' : 'person:')).length;
}

test.describe('Header search type toggle (All / People / Firms)', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await resetBrowserGraphState(page);
		await clearGraphSearchClickConfig(page);
		await page.reload();
		await mockSearchEndpoints(page);
	});

	test('People keeps only active people', async ({ page }) => {
		await runHeaderSearch(page, 'toggle-query', 'people');

		await waitForGraphLabel(page, 'Toggle Person');
		expect(await countGraphLabels(page, 'Inactive Person')).toBe(0);
		expect(await countGraphGroup(page, 'firm')).toBe(0);
	});

	test('Firms keeps only active firms', async ({ page }) => {
		await runHeaderSearch(page, 'toggle-query', 'firms');

		await waitForGraphLabel(page, 'Toggle Firm Inc');
		expect(await countGraphLabels(page, 'Inactive Firm Inc')).toBe(0);
		expect(await countGraphGroup(page, 'individual')).toBe(0);
	});

	test('All shows both people and firm hits', async ({ page }) => {
		await runHeaderSearch(page, 'toggle-query', 'all');

		await waitForGraphLabel(page, 'Toggle Person');
		await waitForGraphLabel(page, 'Toggle Firm Inc');
	});

	test('Selected search scope persists across reload', async ({ page }) => {
		await page.locator('#fg-search-config-toggle').click();
		await page.locator('input[name="fg-search-scope"][value="firms"]').check();
		await expect(page.locator('#finra-app')).toHaveAttribute('data-fg-search-scope', 'firms');

		await page.reload();

		await expect(page.locator('#finra-app')).toHaveAttribute('data-fg-search-scope', 'firms');
	});

	test('Include inactive shows active and inactive people', async ({ page }) => {
		await runHeaderSearch(page, 'toggle-query', 'people-inactive');

		await waitForGraphLabel(page, 'Inactive Person');
		await waitForGraphLabel(page, 'Toggle Person');
		expect(await countGraphGroup(page, 'firm')).toBe(0);
	});

	test('Include inactive shows active and inactive firms', async ({ page }) => {
		await runHeaderSearch(page, 'toggle-query', 'firms-inactive');

		await waitForGraphLabel(page, 'Inactive Firm Inc');
		await waitForGraphLabel(page, 'Toggle Firm Inc');
		expect(await countGraphGroup(page, 'individual')).toBe(0);
	});

	test('Search config toggle opens firm click-reveal options', async ({ page }) => {
		await page.locator('#fg-search-config-toggle').click();
		await expect(page.locator('#fg-search-config-panel')).toBeVisible();
		await expect(page.locator('#fg-click-firm-limit')).toBeVisible();
		await expect(page.locator('#fg-click-keyword')).toBeVisible();
		await expect(page.locator('#fg-click-keyword-strict')).toBeVisible();
		await expect(page.locator('#fg-search-strict')).toBeVisible();
		await expect(page.getByText('Firm click reveal')).toBeVisible();
		await expect(page.getByText('Previous connections (people)')).toHaveCount(0);

		await page.locator('#fg-click-keyword').fill('hopper');
		await page.locator('#fg-click-keyword').press('Enter');
		await expect(page.locator('.fg-click-keyword-chip', { hasText: 'hopper' })).toBeVisible();
		await page.locator('#fg-click-keyword-strict').check();
		await expect(page.locator('#finra-app')).toHaveAttribute('data-fg-click-strict', 'true');
	});
});
