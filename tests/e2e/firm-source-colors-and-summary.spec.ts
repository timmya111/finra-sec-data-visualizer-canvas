import { expect, test, type Page } from '@playwright/test';

import {
	dismissResumeSessionDialog,
	openGraphSideMenu,
	resetBrowserGraphState,
	setClearedGraphSession,
} from './helpers/finra-e2e';

type FirmCoverage = 'finra_only' | 'sec_only' | 'both';

type FirmCase = {
	crd: string;
	coverage: FirmCoverage;
	label: RegExp;
	name: string;
	expectInactive: boolean;
	expectFinraSummary: boolean;
	expectSecSummary: boolean;
	/** Extra SEC document links expected when SEC presence is shown. */
	expectSecDocLinks: boolean;
	detail: Record<string, unknown>;
};

/** Sample CRDs: Transamerica active FINRA/SEC/both + State Farm terminated. */
const FIRM_CASES: FirmCase[] = [
	{
		crd: '8217',
		coverage: 'finra_only',
		label: /TRANSAMERICA CAPITAL/i,
		name: 'TRANSAMERICA CAPITAL, LLC',
		expectInactive: false,
		expectFinraSummary: true,
		expectSecSummary: false,
		expectSecDocLinks: false,
		detail: {
			hasFinraData: true,
			hasSecData: false,
			basicInformation: {
				firmId: 8217,
				firmName: 'TRANSAMERICA CAPITAL, LLC',
				bcScope: 'ACTIVE',
				firmStatus: 'Approved',
				bdSECNumber: '24829',
			},
		},
	},
	{
		crd: '107319',
		coverage: 'sec_only',
		label: /TRANSAMERICA RETIREMENT ADVISORS/i,
		name: 'TRANSAMERICA RETIREMENT ADVISORS, LLC',
		expectInactive: false,
		expectFinraSummary: false,
		expectSecSummary: true,
		expectSecDocLinks: true,
		detail: {
			hasFinraData: false,
			hasSecData: true,
			basicInformation: {
				firmId: 107319,
				firmName: 'TRANSAMERICA RETIREMENT ADVISORS, LLC',
				iaScope: 'ACTIVE',
				iaSECNumber: '42910',
			},
		},
	},
	{
		crd: '16164',
		coverage: 'both',
		label: /TRANSAMERICA FINANCIAL ADVISORS/i,
		name: 'TRANSAMERICA FINANCIAL ADVISORS, LLC',
		expectInactive: false,
		expectFinraSummary: true,
		expectSecSummary: true,
		expectSecDocLinks: true,
		detail: {
			hasFinraData: true,
			hasSecData: true,
			basicInformation: {
				firmId: 16164,
				firmName: 'TRANSAMERICA FINANCIAL ADVISORS, LLC',
				bcScope: 'ACTIVE',
				iaScope: 'ACTIVE',
				firmStatus: 'Approved',
				iaSECNumber: '38618',
				bdSECNumber: '16164',
			},
		},
	},
	{
		crd: '3487',
		coverage: 'both',
		label: /STATE FARM INVESTMENT MANAGEMENT/i,
		name: 'STATE FARM INVESTMENT MANAGEMENT CORP.',
		expectInactive: true,
		expectFinraSummary: true,
		expectSecSummary: true,
		expectSecDocLinks: true,
		detail: {
			hasFinraData: true,
			hasSecData: true,
			basicInformation: {
				firmId: 3487,
				firmName: 'STATE FARM INVESTMENT MANAGEMENT CORP.',
				bcScope: 'INACTIVE',
				iaScope: 'ACTIVE',
				firmStatus: 'Terminated',
				firmStatusDate: '06/30/2001',
				iaSECNumber: '8184',
				bdSECNumber: '13379',
				districtName: 'Chicago',
			},
			registrationStatus: [{ secJurisdiction: 'SEC', status: 'Approved', effectiveDate: '12/14/1971' }],
		},
	},
];

function coverageFromNode(node: any): FirmCoverage | 'none' {
	const hasFinra = node?.hasFinraData === true;
	const hasSec = node?.hasSecData === true;
	if (hasFinra && hasSec) return 'both';
	if (hasSec) return 'sec_only';
	if (hasFinra) return 'finra_only';
	const bc = String(node?.bcScope || node?.basicInformation?.bcScope || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '');
	const ia = String(node?.iaScope || node?.basicInformation?.iaScope || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '');
	const iaSec = String(node?.iaSecNumber || node?.basicInformation?.iaSECNumber || node?.basicInformation?.iaSecNumber || '').trim();
	const finra = /(active|inactive|approved|current)/.test(bc);
	const sec = /(active|inactive|approved|current)/.test(ia) || Boolean(iaSec);
	if (finra && sec) return 'both';
	if (sec) return 'sec_only';
	if (finra) return 'finra_only';
	return 'none';
}

async function mockFirmFetchEndpoints(page: Page) {
	await page.route('**/api/finra/graph**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				nodes: [],
				links: [],
				meta: { subset: true, profile: 'custom', renderedNodes: 0, totalNodes: 0, totalLinks: 0 },
			}),
		});
	});

	await page.route('**/api/finra/search**', async (route) => {
		const url = new URL(route.request().url());
		const query = String(url.searchParams.get('query') || url.searchParams.get('q') || '').trim();
		const firm = FIRM_CASES.find((entry) => entry.crd === query);
		if (!firm) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ hits: { total: 0, hits: [] }, results: [], total: 0 }),
			});
			return;
		}
		const hit = { _id: firm.crd, _source: firm.detail };
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				hits: { total: 1, hits: [hit] },
				results: [firm.detail],
				total: 1,
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

	await page.route('**/api/finra/firm/**', async (route) => {
		const match = route.request().url().match(/\/api\/finra\/firm\/(\d+)/);
		const crd = match?.[1] || '';
		const firm = FIRM_CASES.find((entry) => entry.crd === crd);
		if (!firm) {
			await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ found: false }) });
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(firm.detail),
		});
	});
}

async function prepareEmptyGraph(page: Page) {
	await page.goto('/');
	await resetBrowserGraphState(page);
	await setClearedGraphSession(page);
	await page.reload();
	await dismissResumeSessionDialog(page);
	await mockFirmFetchEndpoints(page);
	await expect(page.locator('#fg-fetch-input')).toBeVisible();
}

async function fetchFirmCrd(page: Page, crd: string) {
	await page.locator('#fg-search-type').selectOption('firms');
	const fetchInput = page.locator('#fg-fetch-input');
	const fetchButton = page.locator('#fg-database-search');
	await fetchInput.fill(crd);
	await expect(fetchButton).toBeEnabled();
	await fetchButton.click();
	await expect(fetchButton).toBeEnabled({ timeout: 60_000 });
	await expect
		.poll(async () => page.locator('#finra-app').getAttribute('data-graph-empty'), {
			timeout: 30_000,
			message: `expected fetching firm ${crd} to leave the empty-graph state`,
		})
		.toBe('false');
}

async function waitForFetchedFirm(page: Page, crd: string) {
	await expect
		.poll(
			async () =>
				page.evaluate((firmCrd) => {
					const nodes = ((window as any).__FINRA_GRAPH_NODES || []) as any[];
					return nodes.some((node) => String(node?.id || '') === `firm:${firmCrd}` || String(node?.firmId || '') === firmCrd);
				}, crd),
			{
				timeout: 45_000,
				message: `expected firm ${crd} to appear in __FINRA_GRAPH_NODES after fetch`,
			},
		)
		.toBe(true);
}

async function readFetchedFirm(page: Page, crd: string) {
	return page.evaluate((firmCrd) => {
		const nodes = ((window as any).__FINRA_GRAPH_NODES || []) as any[];
		return (
			nodes.find((node) => String(node?.id || '') === `firm:${firmCrd}` || String(node?.firmId || '') === firmCrd) || null
		);
	}, crd);
}

async function readFirmPaintFlags(page: Page, crd: string) {
	return page.evaluate((firmCrd) => {
		const nodes = ((window as any).__FINRA_GRAPH_NODES || []) as any[];
		const node =
			nodes.find((entry) => String(entry?.id || '') === `firm:${firmCrd}` || String(entry?.firmId || '') === firmCrd) ||
			null;
		const dbg = typeof (window as any).__fgDebugNode === 'function' ? (window as any).__fgDebugNode(firmCrd) : null;
		return {
			id: node?.id || null,
			_vizInactive: node?._vizInactive === true,
			isNodeInactive: dbg?.isNodeInactive === true,
			firmStatus: node?.firmStatus || node?.basicInformation?.firmStatus || null,
			hasFinraData: node?.hasFinraData === true,
			hasSecData: node?.hasSecData === true,
		};
	}, crd);
}

async function selectFirmOnGraph(page: Page, crd: string) {
	const svgNode = page.locator('.fg-node').filter({ hasText: new RegExp(crd) }).first();
	if (await svgNode.count()) {
		await svgNode.click({ force: true });
	} else {
		// Canvas mode often has no SVG hit targets. Deep-link select keeps the fetched graph
		// session and focuses the firm for sidebar summary-link checks.
		await page.goto(`/firm/${crd}`);
		await dismissResumeSessionDialog(page);
	}

	await expect
		.poll(async () => page.evaluate(() => window.location.pathname), {
			timeout: 20_000,
			message: `expected selecting firm ${crd} to land on /firm/${crd}`,
		})
		.toBe(`/firm/${crd}`);
}

function isAppHomeUrl(url: string) {
	try {
		const parsed = new URL(url);
		if (!/localhost|127\.0\.0\.1|vercel\.app|finra/i.test(parsed.host) && !parsed.host.includes('4444')) {
			return false;
		}
		return parsed.pathname === '/' || parsed.pathname === '';
	} catch {
		return false;
	}
}

async function assertExternalLinkDoesNotBounceHome(page: Page, href: string, label: string) {
	const response = await page.request.get(href, {
		maxRedirects: 5,
		failOnStatusCode: false,
	});
	const finalUrl = response.url();
	if (isAppHomeUrl(finalUrl)) {
		throw new Error(
			`${label} redirected to the app home (${finalUrl}). Recheck the external endpoint: ${href}`,
		);
	}
	expect(
		/brokercheck\.finra\.org|files\.brokercheck\.finra\.org|adviserinfo\.sec\.gov|reports\.adviserinfo\.sec\.gov/i.test(
			finalUrl,
		),
		`${label} final URL should stay on FINRA/SEC hosts (got ${finalUrl}). Recheck external endpoint: ${href}`,
	).toBe(true);
}

async function collectSidebarExternalLinks(page: Page) {
	return page.evaluate(() => {
		const root = document.getElementById('fg-sidebar');
		if (!root) return [] as Array<{ text: string; href: string; className: string }>;
		return Array.from(root.querySelectorAll<HTMLAnchorElement>('a.fg-ext-link'))
			.map((anchor) => ({
				text: String(anchor.textContent || '')
					.replace(/\s+/g, ' ')
					.trim(),
				href: String(anchor.getAttribute('href') || '').trim(),
				className: String(anchor.className || ''),
			}))
			.filter((entry) => entry.href);
	});
}

test.describe('Fetched firm source colors and FINRA/SEC summary links', () => {
	test('search-fetched FINRA-only, SEC-only, both, and terminated firms paint correctly and sidebar links stay external', async ({
		page,
	}) => {
		test.setTimeout(240_000);
		await prepareEmptyGraph(page);

		for (const firm of FIRM_CASES) {
			await fetchFirmCrd(page, firm.crd);
			await waitForFetchedFirm(page, firm.crd);

			await expect
				.poll(
					async () => {
						const node = await readFetchedFirm(page, firm.crd);
						return coverageFromNode(node);
					},
					{
						timeout: 30_000,
						message: `expected firm ${firm.crd} to expose ${firm.coverage} source coverage before selection`,
					},
				)
				.toBe(firm.coverage);

			const beforeSelect = await readFetchedFirm(page, firm.crd);
			expect(beforeSelect, `firm ${firm.crd} should exist before click`).toBeTruthy();
			expect(String(beforeSelect?.label || '')).toMatch(firm.label);

			if (firm.expectInactive) {
				await expect
					.poll(
						async () => {
							const flags = await readFirmPaintFlags(page, firm.crd);
							return flags.isNodeInactive || flags._vizInactive;
						},
						{
							timeout: 20_000,
							message: `expected terminated firm ${firm.crd} to be inactive/gray before or after hydrate`,
						},
					)
					.toBe(true);
			}
		}

		for (const firm of FIRM_CASES) {
			await selectFirmOnGraph(page, firm.crd);
			await openGraphSideMenu(page, { expandInfo: true });

			await expect
				.poll(
					async () =>
						page.evaluate(
							() =>
								document.getElementById('fg-sidebar')?.getAttribute('data-displayed-id') ||
								document.getElementById('fg-sidebar')?.dataset?.displayedId ||
								'',
						),
					{
						timeout: 20_000,
						message: `expected sidebar to focus firm ${firm.crd}`,
					},
				)
				.toBe(`firm:${firm.crd}`);

			const paintFlags = await readFirmPaintFlags(page, firm.crd);
			if (firm.expectInactive) {
				expect(paintFlags.isNodeInactive || paintFlags._vizInactive, `firm ${firm.crd} should stay inactive after select`).toBe(
					true,
				);
			} else {
				expect(paintFlags.isNodeInactive, `active firm ${firm.crd} should not be inactive`).toBe(false);
			}

			// Coverage must survive select hydrate (no bdSEC→iaSec flip to both).
			await expect
				.poll(async () => coverageFromNode(await readFetchedFirm(page, firm.crd)), {
					timeout: 15_000,
					message: `expected firm ${firm.crd} to keep ${firm.coverage} coverage after select`,
				})
				.toBe(firm.coverage);

			const finraSummary = page.locator('#fg-sidebar a.fg-ext-link.bc', { hasText: /FINRA Summary/i });
			const secSummary = page.locator('#fg-sidebar a.fg-ext-link.sec', { hasText: /SEC AdvisorInfo Summary/i });
			const formAdv = page.locator('#fg-sidebar a.fg-ext-link', { hasText: /Latest Form ADV filed/i });
			const brochure = page.locator('#fg-sidebar a.fg-ext-link', { hasText: /SEC firm brochure/i });
			const formCrs = page.locator('#fg-sidebar a.fg-ext-link', { hasText: /SEC Form CRS/i });

			if (firm.expectFinraSummary) {
				await expect(finraSummary).toHaveCount(1);
				const href = await finraSummary.getAttribute('href');
				expect(href, `FINRA Summary href for ${firm.crd}`).toBeTruthy();
				expect(href!).toContain(`brokercheck.finra.org/firm/summary/${firm.crd}`);
				await assertExternalLinkDoesNotBounceHome(page, href!, `FINRA Summary for ${firm.crd}`);
			} else {
				await expect(finraSummary).toHaveCount(0);
			}

			if (firm.expectSecSummary) {
				await expect(secSummary).toHaveCount(1);
				const href = await secSummary.getAttribute('href');
				expect(href, `SEC AdvisorInfo Summary href for ${firm.crd}`).toBeTruthy();
				expect(href!).toContain(`adviserinfo.sec.gov/firm/summary/${firm.crd}`);
				await assertExternalLinkDoesNotBounceHome(page, href!, `SEC AdvisorInfo Summary for ${firm.crd}`);
			} else {
				await expect(secSummary).toHaveCount(0);
			}

			if (firm.expectSecDocLinks) {
				await expect(formAdv).toHaveCount(1);
				await expect(brochure).toHaveCount(1);
				await expect(formCrs).toHaveCount(1);
				for (const locator of [formAdv, brochure, formCrs]) {
					const label = (await locator.textContent())?.replace(/\s+/g, ' ').trim() || 'SEC doc link';
					const href = await locator.getAttribute('href');
					expect(href, `${label} href for ${firm.crd}`).toBeTruthy();
					await assertExternalLinkDoesNotBounceHome(page, href!, `${label} for ${firm.crd}`);
				}
			} else {
				await expect(formAdv).toHaveCount(0);
				await expect(brochure).toHaveCount(0);
				await expect(formCrs).toHaveCount(0);
			}

			// Every sidebar external link must stay on FINRA/SEC hosts (catch extras like Detailed Report).
			const allLinks = await collectSidebarExternalLinks(page);
			expect(allLinks.length, `expected sidebar external links for firm ${firm.crd}`).toBeGreaterThan(0);
			for (const link of allLinks) {
				expect(link.href, `${link.text || 'sidebar link'} for ${firm.crd}`).toBeTruthy();
				await assertExternalLinkDoesNotBounceHome(page, link.href, `${link.text || 'sidebar link'} for ${firm.crd}`);
			}
		}
	});
});
