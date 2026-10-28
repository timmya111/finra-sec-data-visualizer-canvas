import { expect, test } from '@playwright/test';
import { QUEUE_GRAPH_BRIDGE_KEY } from '../../src/lib/queueGraphBridge';
import { seedStoredSession } from './helpers/finra-e2e';

test('Graph button bridges Queue graph CRDs without query string', async ({ page }) => {
	await page.route('**/api/dashboard/refresh', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ok: true, inventoryTotals: { total: 0, people: 0, firms: 0, unique: 0 } }),
		});
	});
	await page.route('**/api/finra/**', async (route) => {
		const url = route.request().url();
		if (url.includes('/api/finra/individual/3102054')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					ok: true,
					nodes: [{ id: 'person:3102054', group: 'individual', crd: '3102054', label: 'Regression Person One' }],
					links: [],
				}),
			});
			return;
		}
		if (url.includes('/api/finra/graph') || url.includes('/api/finra/profile')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ nodes: [], links: [], meta: {} }),
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ok: true, results: [], nodes: [], links: [] }),
		});
	});

	await page.goto('/dashboard');
	await page.evaluate(() => {
		localStorage.setItem(
			'finra_dashboard_history',
			JSON.stringify([
				{
					id: '3102054',
					entity: 'individual',
					sources: [{ source: 'finra', label: 'FINRA' }],
					name: 'Regression Person One',
					fetchedAt: new Date().toISOString(),
					lastVisitedAt: new Date().toISOString(),
					visitCount: 1,
				},
			]),
		);
	});
	await page.reload();
	await expect(page.getByText('Queue graph', { exact: false })).toBeVisible();
	const graphLink = page.getByRole('link', { name: 'Graph' });
	await expect(graphLink).toHaveAttribute('href', /\/individual\/3102054/);

	await graphLink.click();

	await expect
		.poll(async () => page.evaluate(() => window.location.pathname + window.location.search), {
			timeout: 20_000,
			message: 'expected Graph navigation to the individual route without selected=',
		})
		.toBe('/individual/3102054');

	const href = await page.evaluate(() => window.location.href);
	expect(href).not.toContain('selected=');
	expect(href).not.toContain('isolate=');

	// Bridge is written on click then consumed during graph init (one-shot).
	await expect
		.poll(
			async () =>
				page.evaluate((key) => {
					return sessionStorage.getItem(key);
				}, QUEUE_GRAPH_BRIDGE_KEY),
			{ timeout: 30_000, message: 'expected the one-shot bridge to be consumed after graph init' },
		)
		.toBeNull();

	// Graph click ends the Queue graph session — history is cleared for the next dashboard visit.
	await expect
		.poll(async () => page.evaluate(() => localStorage.getItem('finra_dashboard_history')), {
			timeout: 5_000,
			message: 'expected Queue graph history to be cleared after Graph navigation',
		})
		.toBeNull();
});

test('Dashboard Graph import keeps prior canvas nodes and appends bridged CRDs', async ({ page }) => {
	await page.route('**/api/dashboard/refresh', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ok: true, inventoryTotals: { total: 0, people: 0, firms: 0, unique: 0 } }),
		});
	});
	await page.route('**/api/finra/**', async (route) => {
		const url = route.request().url();
		if (url.includes('/api/finra/individual/3102054')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					ok: true,
					nodes: [{ id: 'person:3102054', group: 'individual', crd: '3102054', label: 'Regression Person One' }],
					links: [],
				}),
			});
			return;
		}
		if (url.includes('/api/finra/individual/999888')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					ok: true,
					nodes: [{ id: 'person:999888', group: 'individual', crd: '999888', label: 'Prior Canvas Person' }],
					links: [],
				}),
			});
			return;
		}
		if (url.includes('/api/finra/graph') || url.includes('/api/finra/profile')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ nodes: [], links: [], meta: {} }),
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ok: true, results: [], nodes: [], links: [] }),
		});
	});

	// Seed a prior graph session the user already had on the canvas.
	await page.goto('/');
	await seedStoredSession(page, {
		extraNodes: [
			{
				id: 'person:999888',
				label: 'Prior Canvas Person',
				group: 'individual',
				crd: '999888',
			},
			{
				id: 'firm:555444',
				label: 'Prior Canvas Firm',
				group: 'firm',
				firmId: '555444',
			},
		],
		extraLinks: [
			{
				source: 'person:999888',
				target: 'firm:555444',
				relationship: 'employed_by',
				isCurrent: true,
			},
		],
		nodePositions: [
			{ id: 'person:999888', x: 120, y: 140 },
			{ id: 'firm:555444', x: 260, y: 180 },
		],
	});
	// Mark this tab as an already-active graph session so restore auto-continues.
	await page.evaluate(() => {
		sessionStorage.setItem('fg_session_active', '1');
	});
	await page.reload();

	const readGraphNodeIds = async () =>
		page.evaluate(() => {
			const nodes = (window as any).__FINRA_GRAPH_NODES as Array<{ id?: string; label?: string }> | undefined;
			if (!Array.isArray(nodes)) return [] as string[];
			return nodes.map((n) => String(n?.id || '')).filter(Boolean).sort();
		});

	await expect
		.poll(async () => readGraphNodeIds(), {
			timeout: 15_000,
			message: 'expected prior session nodes to restore before dashboard import',
		})
		.toEqual(expect.arrayContaining(['person:999888', 'firm:555444']));

	// Dashboard Queue selection → Graph should append, not wipe.
	await page.goto('/dashboard');
	await page.evaluate(() => {
		localStorage.setItem(
			'finra_dashboard_history',
			JSON.stringify([
				{
					id: '3102054',
					entity: 'individual',
					sources: [{ source: 'finra', label: 'FINRA' }],
					name: 'Regression Person One',
					fetchedAt: new Date().toISOString(),
					lastVisitedAt: new Date().toISOString(),
					visitCount: 1,
				},
			]),
		);
	});
	await page.reload();
	await expect(page.getByText('Queue graph', { exact: false })).toBeVisible();
	const graphLink = page.getByRole('link', { name: 'Graph' });
	await graphLink.click();

	await expect
		.poll(async () => page.evaluate(() => window.location.pathname), {
			timeout: 20_000,
			message: 'expected Graph navigation to the individual route',
		})
		.toBe('/individual/3102054');

	await expect
		.poll(async () => readGraphNodeIds(), {
			timeout: 30_000,
			message: 'expected prior session nodes to remain after Queue Graph import',
		})
		.toEqual(expect.arrayContaining(['person:999888', 'firm:555444', 'person:3102054']));
});

test('Dashboard Graph import restores prior nodes from position-only (minimal) sessions', async ({ page }) => {
	const catalog: Record<string, { id: string; group: string; crd?: string; firmId?: string; label: string }> = {
		'person:3102054': { id: 'person:3102054', group: 'individual', crd: '3102054', label: 'Regression Person One' },
		'person:999888': { id: 'person:999888', group: 'individual', crd: '999888', label: 'Prior Canvas Person' },
		'firm:555444': { id: 'firm:555444', group: 'firm', firmId: '555444', label: 'Prior Canvas Firm' },
	};
	await page.route('**/api/dashboard/refresh', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ok: true, inventoryTotals: { total: 0, people: 0, firms: 0, unique: 0 } }),
		});
	});
	await page.route('**/api/finra/**', async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		if (path.includes('/api/finra/nodes-by-ids')) {
			const ids = String(url.searchParams.get('ids') || '')
				.split(',')
				.map((id) => id.trim())
				.filter(Boolean);
			const nodes = ids.map((id) => catalog[id]).filter(Boolean);
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ ok: true, nodes, links: [] }),
			});
			return;
		}
		const individualMatch = path.match(/\/api\/finra\/individual\/(\d+)/);
		if (individualMatch) {
			const node = catalog[`person:${individualMatch[1]}`];
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(node ? { ok: true, ...node, nodes: [node], links: [] } : { found: false }),
			});
			return;
		}
		const firmMatch = path.match(/\/api\/finra\/firm\/(\d+)/);
		if (firmMatch) {
			const node = catalog[`firm:${firmMatch[1]}`];
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(node ? { ok: true, ...node, nodes: [node], links: [] } : { found: false }),
			});
			return;
		}
		if (path.includes('/api/finra/graph') || path.includes('/api/finra/profile')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ nodes: [], links: [], meta: {} }),
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ok: true, results: [], nodes: [], links: [] }),
		});
	});

	// Simulate quota-downgraded minimal session: no extraNodes/extraNodeIds, only positions + selection.
	await page.goto('/');
	await seedStoredSession(page, {
		cleared: false,
		selectedNodeId: 'person:999888',
		highlightedNodes: [{ id: 'person:999888', hops: 1 }],
		extraNodes: [],
		extraNodeIds: [],
		extraLinks: [],
		renderedServerIds: [],
		nodePositions: [
			{ id: 'person:999888', x: 120, y: 140 },
			{ id: 'firm:555444', x: 260, y: 180 },
		],
	});
	await page.evaluate(() => {
		sessionStorage.setItem('fg_session_active', '1');
	});

	await page.goto('/dashboard');
	await page.evaluate(() => {
		localStorage.setItem(
			'finra_dashboard_history',
			JSON.stringify([
				{
					id: '3102054',
					entity: 'individual',
					sources: [{ source: 'finra', label: 'FINRA' }],
					name: 'Regression Person One',
					fetchedAt: new Date().toISOString(),
					lastVisitedAt: new Date().toISOString(),
					visitCount: 1,
				},
			]),
		);
	});
	await page.reload();
	await expect(page.getByText('Queue graph', { exact: false })).toBeVisible();
	await page.getByRole('link', { name: 'Graph' }).click();

	await expect
		.poll(async () => page.evaluate(() => window.location.pathname), {
			timeout: 20_000,
			message: 'expected Graph navigation to the individual route',
		})
		.toBe('/individual/3102054');

	const readGraphNodeIds = async () =>
		page.evaluate(() => {
			const nodes = (window as any).__FINRA_GRAPH_NODES as Array<{ id?: string }> | undefined;
			if (!Array.isArray(nodes)) return [] as string[];
			return nodes.map((n) => String(n?.id || '')).filter(Boolean).sort();
		});

	await expect
		.poll(async () => readGraphNodeIds(), {
			timeout: 30_000,
			message: 'expected position-only prior nodes to rehydrate and survive Queue Graph import',
		})
		.toEqual(expect.arrayContaining(['person:999888', 'firm:555444', 'person:3102054']));
});
