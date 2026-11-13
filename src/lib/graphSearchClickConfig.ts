/** Header search scope + firm click-reveal preferences for the graph canvas. */

export type GraphSearchScope = 'all' | 'people' | 'firms';

export type GraphSearchClickConfig = {
	searchScope: GraphSearchScope;
	includeInactive: boolean;
	/** Firm click batch size. People clicks are uncapped and unfiltered. */
	firmRevealLimit: number;
	/** When true, firm clicks also reveal previous (inactive) roster people. */
	firmRevealPrevious: boolean;
	/** Firm click only: only reveal roster people whose name/CRD matches (empty = all). */
	clickRevealKeyword: string;
};

export const GRAPH_SEARCH_CLICK_CONFIG_STORAGE_KEY = 'finra_graph_search_click_config_v1';
export const DEFAULT_FIRM_REVEAL_LIMIT = 100;

export const DEFAULT_GRAPH_SEARCH_CLICK_CONFIG: GraphSearchClickConfig = {
	searchScope: 'people',
	includeInactive: false,
	firmRevealLimit: DEFAULT_FIRM_REVEAL_LIMIT,
	firmRevealPrevious: false,
	clickRevealKeyword: '',
};

export function normalizeGraphSearchScope(value: unknown): GraphSearchScope {
	const normalized = String(value || '')
		.trim()
		.toLowerCase();
	if (normalized === 'firms' || normalized === 'firm') return 'firms';
	if (normalized === 'all') return 'all';
	return 'people';
}

export function normalizeFirmRevealLimit(value: unknown): number {
	const n = Math.floor(Number(value));
	if (!Number.isFinite(n) || n < 1) return DEFAULT_FIRM_REVEAL_LIMIT;
	return Math.min(500, n);
}

export function normalizeGraphSearchClickConfig(raw: Partial<GraphSearchClickConfig> | null | undefined): GraphSearchClickConfig {
	const base = raw && typeof raw === 'object' ? raw : {};
	return {
		searchScope: normalizeGraphSearchScope(base.searchScope),
		includeInactive: Boolean(base.includeInactive),
		firmRevealLimit: normalizeFirmRevealLimit(base.firmRevealLimit),
		firmRevealPrevious: Boolean(base.firmRevealPrevious),
		clickRevealKeyword: String(base.clickRevealKeyword || '').trim(),
	};
}

export function loadGraphSearchClickConfig(): GraphSearchClickConfig {
	if (typeof window === 'undefined') return { ...DEFAULT_GRAPH_SEARCH_CLICK_CONFIG };
	try {
		const raw = window.localStorage.getItem(GRAPH_SEARCH_CLICK_CONFIG_STORAGE_KEY);
		if (!raw) {
			// Migrate legacy finra_search_type when present.
			const legacy = String(window.localStorage.getItem('finra_search_type') || '')
				.trim()
				.toLowerCase();
			if (legacy === 'firms' || legacy === 'firms-inactive') {
				return normalizeGraphSearchClickConfig({
					searchScope: 'firms',
					includeInactive: legacy === 'firms-inactive',
				});
			}
			if (legacy === 'all') {
				return normalizeGraphSearchClickConfig({ searchScope: 'all', includeInactive: true });
			}
			if (legacy === 'people-inactive') {
				return normalizeGraphSearchClickConfig({ searchScope: 'people', includeInactive: true });
			}
			if (legacy === 'people') {
				return normalizeGraphSearchClickConfig({ searchScope: 'people', includeInactive: false });
			}
			return { ...DEFAULT_GRAPH_SEARCH_CLICK_CONFIG };
		}
		return normalizeGraphSearchClickConfig(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_GRAPH_SEARCH_CLICK_CONFIG };
	}
}

export function saveGraphSearchClickConfig(config: GraphSearchClickConfig) {
	if (typeof window === 'undefined') return;
	const normalized = normalizeGraphSearchClickConfig(config);
	try {
		window.localStorage.setItem(GRAPH_SEARCH_CLICK_CONFIG_STORAGE_KEY, JSON.stringify(normalized));
		// Keep legacy key roughly in sync for older readers / e2e helpers.
		// includeInactive on "all" still maps to 'all' (no activity filter).
		const legacy =
			normalized.searchScope === 'all' ? 'all'
			: normalized.includeInactive ?
				normalized.searchScope === 'firms' ?
					'firms-inactive'
				:	'people-inactive'
			: normalized.searchScope === 'firms' ? 'firms'
			: 'people';
		window.localStorage.setItem('finra_search_type', legacy);
	} catch {
		/* ignore */
	}
}

export function searchConfigIncludesPeople(scope: GraphSearchScope) {
	return scope === 'all' || scope === 'people';
}

export function searchConfigIncludesFirms(scope: GraphSearchScope) {
	return scope === 'all' || scope === 'firms';
}

/**
 * Activity filter for header search.
 * includeInactive=false → active-only for people/firms scopes.
 * includeInactive=true → no activity filter (active + inactive).
 */
export function searchConfigActivityMode(config: Pick<GraphSearchClickConfig, 'searchScope' | 'includeInactive'>): 'active' | null {
	if (config.includeInactive) return null;
	return 'active';
}

/** Stable key for progressive search continuation (scope + inactive flag). */
export function graphSearchConfigQueryKeyPart(config: Pick<GraphSearchClickConfig, 'searchScope' | 'includeInactive'>) {
	const scope = normalizeGraphSearchScope(config.searchScope);
	const inactive = config.includeInactive ? 'inactive' : 'active';
	return `${scope}:${inactive}`;
}

/** Map new config onto legacy search-type strings still used by helpers / e2e. */
export function graphSearchConfigToLegacySearchType(config: Pick<GraphSearchClickConfig, 'searchScope' | 'includeInactive'>) {
	const scope = normalizeGraphSearchScope(config.searchScope);
	if (scope === 'all') return 'all';
	if (config.includeInactive) return scope === 'firms' ? 'firms-inactive' : 'people-inactive';
	return scope === 'firms' ? 'firms' : 'people';
}

/** Split keyword filter into tokens; empty string → no filter. */
export function parseClickRevealKeywordTokens(keyword: string | null | undefined): string[] {
	return String(keyword || '')
		.trim()
		.toLowerCase()
		.split(/[\s,]+/)
		.map((token) => token.trim())
		.filter(Boolean);
}

export function nodeMatchesClickRevealKeyword(
	node: { id?: unknown; label?: unknown; name?: unknown; firmName?: unknown; crd?: unknown } | null | undefined,
	keyword: string | null | undefined,
): boolean {
	const tokens = parseClickRevealKeywordTokens(keyword);
	if (!tokens.length) return true;
	if (!node) return false;
	const id = String(node.id || '');
	const crd = String(node.crd || id.replace(/^(?:person|firm):/i, ''));
	const haystack = [node.label, node.name, node.firmName, id, crd]
		.map((value) => String(value || '').toLowerCase())
		.join(' ');
	return tokens.every((token) => haystack.includes(token));
}

export function connectionMatchesClickRevealKeyword(connection: any, keyword: string | null | undefined): boolean {
	const tokens = parseClickRevealKeywordTokens(keyword);
	if (!tokens.length) return true;
	const crd = String(connection?.crd || connection?.individualId || connection?.ind_crd || connection?.id || '').trim();
	const name = [
		connection?.label,
		connection?.name,
		connection?.fullName,
		connection?.firstName,
		connection?.lastName,
		connection?.ind_firstname,
		connection?.ind_lastname,
	]
		.map((value) => String(value || '').trim())
		.filter(Boolean)
		.join(' ');
	const haystack = `${name} ${crd}`.toLowerCase();
	return tokens.every((token) => haystack.includes(token));
}

/** Apply config onto #finra-app dataset so non-React graph code can read it. */
export function syncGraphSearchClickConfigToDom(config: GraphSearchClickConfig, root: HTMLElement | null = null) {
	if (typeof document === 'undefined') return;
	const el = root || document.getElementById('finra-app');
	if (!el) return;
	const normalized = normalizeGraphSearchClickConfig(config);
	el.dataset.fgSearchScope = normalized.searchScope;
	el.dataset.fgSearchIncludeInactive = normalized.includeInactive ? 'true' : 'false';
	el.dataset.fgClickFirmLimit = String(normalized.firmRevealLimit);
	el.dataset.fgClickFirmPrevious = normalized.firmRevealPrevious ? 'true' : 'false';
	el.dataset.fgClickKeyword = normalized.clickRevealKeyword;
	delete el.dataset.fgClickPeoplePrevious;
}

export function readGraphSearchClickConfigFromDom(root: HTMLElement | null = null): GraphSearchClickConfig {
	if (typeof document === 'undefined') return { ...DEFAULT_GRAPH_SEARCH_CLICK_CONFIG };
	const el = root || document.getElementById('finra-app');
	if (!el?.dataset) return loadGraphSearchClickConfig();
	return normalizeGraphSearchClickConfig({
		searchScope: el.dataset.fgSearchScope as GraphSearchScope,
		includeInactive: el.dataset.fgSearchIncludeInactive === 'true',
		firmRevealLimit: Number(el.dataset.fgClickFirmLimit),
		firmRevealPrevious: el.dataset.fgClickFirmPrevious === 'true',
		clickRevealKeyword: el.dataset.fgClickKeyword || '',
	});
}
