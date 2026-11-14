import { expect, type Page } from '@playwright/test';

export type E2ESearchScope = 'all' | 'people' | 'firms';

export type E2ESearchClickConfig = {
	searchScope?: E2ESearchScope;
	includeInactive?: boolean;
	searchStrict?: boolean;
	firmRevealLimit?: number;
	firmRevealPrevious?: boolean;
	clickRevealKeywords?: string[];
	clickRevealKeywordsEnabled?: boolean;
	clickRevealStrict?: boolean;
};

/** Clear persisted search/click prefs so tests start from defaults. */
export async function clearGraphSearchClickConfig(page: Page) {
	await page.evaluate(() => {
		try {
			window.localStorage.removeItem('finra_graph_search_click_config_v1');
			window.localStorage.removeItem('finra_search_type');
		} catch {
			/* ignore */
		}
	});
}

/**
 * Apply header search / click-reveal prefs through the real toggle UI so React state
 * and #finra-app dataset stay aligned.
 */
export async function setGraphSearchClickConfig(page: Page, patch: E2ESearchClickConfig) {
	const toggle = page.locator('#fg-search-config-toggle');
	await expect(toggle).toBeVisible();
	const panel = page.locator('#fg-search-config-panel');
	if (!(await panel.isVisible().catch(() => false))) {
		await toggle.click();
	}
	await expect(panel).toBeVisible();

	if (patch.searchScope) {
		await page.locator(`input[name="fg-search-scope"][value="${patch.searchScope}"]`).check();
	}
	if (typeof patch.includeInactive === 'boolean') {
		const box = panel.locator('label', { hasText: 'Include inactive' }).locator('input[type="checkbox"]');
		if (patch.includeInactive) await box.check();
		else await box.uncheck();
	}
	if (typeof patch.searchStrict === 'boolean') {
		const box = page.locator('#fg-search-strict');
		if (patch.searchStrict) await box.check();
		else await box.uncheck();
	}
	if (typeof patch.firmRevealLimit === 'number') {
		await page.locator('#fg-click-firm-limit').fill(String(patch.firmRevealLimit));
	}
	if (typeof patch.firmRevealPrevious === 'boolean') {
		const box = panel.locator('label', { hasText: 'Previous connections' }).locator('input[type="checkbox"]');
		if (patch.firmRevealPrevious) await box.check();
		else await box.uncheck();
	}
	if (Array.isArray(patch.clickRevealKeywords) || typeof patch.clickRevealKeywordsEnabled === 'boolean') {
		const enabledBox = page.locator('#fg-click-keyword-tags-enabled');
		// Chips only render while Tags is on — enable before clear/add.
		if (Array.isArray(patch.clickRevealKeywords)) {
			await enabledBox.check();
			const removeButtons = panel.locator('.fg-click-keyword-chip-remove');
			while ((await removeButtons.count()) > 0) {
				await removeButtons.first().click();
			}
			for (const tag of patch.clickRevealKeywords) {
				await page.locator('#fg-click-keyword').fill(tag);
				await page.locator('#fg-click-keyword').press('Enter');
			}
		}
		if (typeof patch.clickRevealKeywordsEnabled === 'boolean') {
			if (patch.clickRevealKeywordsEnabled) await enabledBox.check();
			else await enabledBox.uncheck();
		}
	}
	if (typeof patch.clickRevealStrict === 'boolean') {
		const box = page.locator('#fg-click-keyword-strict');
		if (patch.clickRevealStrict) await box.check();
		else await box.uncheck();
	}

	if (patch.searchScope) {
		await expect(page.locator('#finra-app')).toHaveAttribute('data-fg-search-scope', patch.searchScope);
	}
	if (typeof patch.includeInactive === 'boolean') {
		await expect(page.locator('#finra-app')).toHaveAttribute(
			'data-fg-search-include-inactive',
			patch.includeInactive ? 'true' : 'false',
		);
	}

	// Close panel so it does not cover the Search button.
	await toggle.click();
	await expect(panel).toHaveCount(0);
}

/** Map legacy e2e search-type values onto the new scope + includeInactive pair. */
export async function setLegacyHeaderSearchType(
	page: Page,
	type: 'all' | 'people' | 'firms' | 'people-inactive' | 'firms-inactive',
) {
	if (type === 'all') {
		await setGraphSearchClickConfig(page, { searchScope: 'all', includeInactive: true });
		return;
	}
	if (type === 'people') {
		await setGraphSearchClickConfig(page, { searchScope: 'people', includeInactive: false });
		return;
	}
	if (type === 'firms') {
		await setGraphSearchClickConfig(page, { searchScope: 'firms', includeInactive: false });
		return;
	}
	if (type === 'people-inactive') {
		// New UI has no inactive-only mode; include inactive under people scope.
		await setGraphSearchClickConfig(page, { searchScope: 'people', includeInactive: true });
		return;
	}
	await setGraphSearchClickConfig(page, { searchScope: 'firms', includeInactive: true });
}

export async function graphNodeLabels(page: Page) {
	return page.evaluate(() => {
		const nodes = ((window as any).__FINRA_GRAPH_NODES || []) as Array<{ id?: string; label?: string; group?: string }>;
		return nodes.map((node) => ({
			id: String(node?.id || ''),
			label: String(node?.label || ''),
			group: String(node?.group || ''),
		}));
	});
}
