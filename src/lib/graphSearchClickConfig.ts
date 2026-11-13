/** Header search scope + firm click-reveal preferences for the graph canvas. */

export type GraphSearchScope = 'all' | 'people' | 'firms';

export type GraphSearchClickConfig = {
	searchScope: GraphSearchScope;
	includeInactive: boolean;
	/**
	 * Header Search matching mode.
	 * false (default) = fuzzy ranking/token match.
	 * true = only keep hits whose name/CRD contains the query as an exact contiguous phrase.
	 */
	searchStrict: boolean;
	/** Firm click batch size. People clicks are uncapped and unfiltered. */
	firmRevealLimit: number;
	/** When true, firm clicks also reveal previous (inactive) roster people. */
	firmRevealPrevious: boolean;
	/** Firm click only: reveal roster people matching any of these keyword tags (empty = all). */
	clickRevealKeywords: string[];
	/**
	 * Firm click keyword matching mode.
	 * false (default) = fuzzy: every token of a tag may appear anywhere in the name/CRD.
	 * true = strict: tag must appear as an exact contiguous phrase within the name/CRD.
	 */
	clickRevealStrict: boolean;
};

export const GRAPH_SEARCH_CLICK_CONFIG_STORAGE_KEY = 'finra_graph_search_click_config_v1';
export const DEFAULT_FIRM_REVEAL_LIMIT = 100;

export const DEFAULT_GRAPH_SEARCH_CLICK_CONFIG: GraphSearchClickConfig = {
	searchScope: 'people',
	includeInactive: false,
	searchStrict: false,
	firmRevealLimit: DEFAULT_FIRM_REVEAL_LIMIT,
	firmRevealPrevious: false,
	clickRevealKeywords: [],
	clickRevealStrict: false,
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

/** Split raw keyword text into committed tags (comma / newline separated). */
export function parseClickRevealKeywordTags(value: unknown): string[] {
	if (Array.isArray(value)) {
		const tags: string[] = [];
		const seen = new Set<string>();
		for (const entry of value) {
			for (const tag of parseClickRevealKeywordTags(entry)) {
				const key = tag.toLowerCase();
				if (seen.has(key)) continue;
				seen.add(key);
				tags.push(tag);
			}
		}
		return tags;
	}
	const tags: string[] = [];
	const seen = new Set<string>();
	for (const part of String(value || '').split(/[,\n]+/)) {
		const tag = part.trim();
		if (!tag) continue;
		const key = tag.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		tags.push(tag);
	}
	return tags;
}

export function normalizeGraphSearchClickConfig(raw: Partial<GraphSearchClickConfig> & { clickRevealKeyword?: unknown } | null | undefined): GraphSearchClickConfig {
	const base = raw && typeof raw === 'object' ? raw : {};
	const legacyKeyword = (base as { clickRevealKeyword?: unknown }).clickRevealKeyword;
	const fromArray = Array.isArray(base.clickRevealKeywords) ? base.clickRevealKeywords : null;
	const clickRevealKeywords = parseClickRevealKeywordTags(fromArray ?? legacyKeyword ?? []);
	return {
		searchScope: normalizeGraphSearchScope(base.searchScope),
		includeInactive: Boolean(base.includeInactive),
		searchStrict: Boolean(base.searchStrict),
		firmRevealLimit: normalizeFirmRevealLimit(base.firmRevealLimit),
		firmRevealPrevious: Boolean(base.firmRevealPrevious),
		clickRevealKeywords,
		clickRevealStrict: Boolean(base.clickRevealStrict),
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

/** Stable key for progressive search continuation (scope + inactive + strict). */
export function graphSearchConfigQueryKeyPart(
	config: Pick<GraphSearchClickConfig, 'searchScope' | 'includeInactive' | 'searchStrict'>,
) {
	const scope = normalizeGraphSearchScope(config.searchScope);
	const inactive = config.includeInactive ? 'inactive' : 'active';
	const strict = config.searchStrict ? 'strict' : 'fuzzy';
	return `${scope}:${inactive}:${strict}`;
}

/** Build a searchable name/CRD haystack from a FINRA/SEC search hit. */
export function searchHitLabelHaystack(hit: any): string {
	const src = hit?._source || hit || {};
	const basic = src?.basicInformation && typeof src.basicInformation === 'object' ? src.basicInformation : {};
	const personLabel = [src?.ind_firstname, src?.ind_middlename, src?.ind_lastname, basic?.firstName, basic?.middleName, basic?.lastName]
		.filter(Boolean)
		.join(' ');
	const firmLabel = String(
		src?.label || src?.firm_name || src?.firmName || src?.name || basic?.firmName || basic?.name || '',
	).trim();
	const crd = String(
		src?.ind_source_id || src?.ind_crd || src?.firm_id || src?.firm_source_id || src?.firmId || basic?.individualId || basic?.firmId || src?.crd || '',
	).trim();
	return [personLabel, firmLabel, src?.label, src?.name, crd].map((value) => String(value || '').trim()).filter(Boolean).join(' ');
}

/**
 * When searchStrict is on, require the query as an exact contiguous phrase in the hit name/CRD.
 * Numeric CRD queries always match on id equality. Empty query always matches.
 */
export function searchHitMatchesSearchQuery(hit: any, rawQuery: string, strict: boolean): boolean {
	const query = String(rawQuery || '').trim();
	if (!query || !strict) return true;
	if (/^\d+$/.test(query)) {
		const haystack = searchHitLabelHaystack(hit);
		return haystack.includes(query);
	}
	return matchesClickRevealKeywords(searchHitLabelHaystack(hit), [query], true);
}

/** Map new config onto legacy search-type strings still used by helpers / e2e. */
export function graphSearchConfigToLegacySearchType(config: Pick<GraphSearchClickConfig, 'searchScope' | 'includeInactive'>) {
	const scope = normalizeGraphSearchScope(config.searchScope);
	if (scope === 'all') return 'all';
	if (config.includeInactive) return scope === 'firms' ? 'firms-inactive' : 'people-inactive';
	return scope === 'firms' ? 'firms' : 'people';
}

function tokenizeClickRevealPhrase(phrase: string): string[] {
	return String(phrase || '')
		.toLowerCase()
		.split(/[^a-z0-9#]+/i)
		.map((token) => token.trim())
		.filter(Boolean);
}

function normalizeClickRevealPhrase(value: string): string {
	return String(value || '')
		.toLowerCase()
		.replace(/[’']/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function haystackMatchesClickRevealTag(haystack: string, tag: string, strict: boolean): boolean {
	const normalizedTag = normalizeClickRevealPhrase(tag);
	if (!normalizedTag) return true;
	const normalizedHaystack = normalizeClickRevealPhrase(haystack);
	if (strict) {
		// Exact contiguous phrase within the name/CRD.
		return normalizedHaystack.includes(normalizedTag);
	}
	// Fuzzy: every token may appear anywhere (order-independent).
	const tokens = tokenizeClickRevealPhrase(tag);
	if (!tokens.length) return true;
	const lower = haystack.toLowerCase();
	return tokens.every((token) => lower.includes(token));
}

/** True when haystack matches any keyword tag (OR). Empty tags → match all. */
export function matchesClickRevealKeywords(
	haystack: string,
	keywords: string[] | string | null | undefined,
	strict = false,
): boolean {
	const tags = parseClickRevealKeywordTags(keywords);
	if (!tags.length) return true;
	return tags.some((tag) => haystackMatchesClickRevealTag(haystack, tag, strict));
}

function connectionClickRevealHaystack(connection: any): string {
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
	return `${name} ${crd}`.trim();
}

function nodeClickRevealHaystack(node: { id?: unknown; label?: unknown; name?: unknown; firmName?: unknown; crd?: unknown } | null | undefined): string {
	if (!node) return '';
	const id = String(node.id || '');
	const crd = String(node.crd || id.replace(/^(?:person|firm):/i, ''));
	return [node.label, node.name, node.firmName, id, crd]
		.map((value) => String(value || '').trim())
		.filter(Boolean)
		.join(' ');
}

export function nodeMatchesClickRevealKeyword(
	node: { id?: unknown; label?: unknown; name?: unknown; firmName?: unknown; crd?: unknown } | null | undefined,
	keywords: string[] | string | null | undefined,
	strict = false,
): boolean {
	const tags = parseClickRevealKeywordTags(keywords);
	if (!tags.length) return true;
	if (!node) return false;
	return matchesClickRevealKeywords(nodeClickRevealHaystack(node), tags, strict);
}

export function connectionMatchesClickRevealKeyword(
	connection: any,
	keywords: string[] | string | null | undefined,
	strict = false,
): boolean {
	const tags = parseClickRevealKeywordTags(keywords);
	if (!tags.length) return true;
	return matchesClickRevealKeywords(connectionClickRevealHaystack(connection), tags, strict);
}

/** @deprecated Prefer parseClickRevealKeywordTags / matchesClickRevealKeywords. */
export function parseClickRevealKeywordTokens(keyword: string | null | undefined): string[] {
	return tokenizeClickRevealPhrase(String(keyword || ''));
}

/** Apply config onto #finra-app dataset so non-React graph code can read it. */
export function syncGraphSearchClickConfigToDom(config: GraphSearchClickConfig, root: HTMLElement | null = null) {
	if (typeof document === 'undefined') return;
	const el = root || document.getElementById('finra-app');
	if (!el) return;
	const normalized = normalizeGraphSearchClickConfig(config);
	el.dataset.fgSearchScope = normalized.searchScope;
	el.dataset.fgSearchIncludeInactive = normalized.includeInactive ? 'true' : 'false';
	el.dataset.fgSearchStrict = normalized.searchStrict ? 'true' : 'false';
	el.dataset.fgClickFirmLimit = String(normalized.firmRevealLimit);
	el.dataset.fgClickFirmPrevious = normalized.firmRevealPrevious ? 'true' : 'false';
	el.dataset.fgClickKeywords = JSON.stringify(normalized.clickRevealKeywords);
	el.dataset.fgClickStrict = normalized.clickRevealStrict ? 'true' : 'false';
	// Legacy single-string dataset for older readers.
	el.dataset.fgClickKeyword = normalized.clickRevealKeywords.join(', ');
	delete el.dataset.fgClickPeoplePrevious;
}

export function readGraphSearchClickConfigFromDom(root: HTMLElement | null = null): GraphSearchClickConfig {
	if (typeof document === 'undefined') return { ...DEFAULT_GRAPH_SEARCH_CLICK_CONFIG };
	const el = root || document.getElementById('finra-app');
	if (!el?.dataset) return loadGraphSearchClickConfig();
	let keywords: unknown = el.dataset.fgClickKeywords;
	if (typeof keywords === 'string' && keywords.trim().startsWith('[')) {
		try {
			keywords = JSON.parse(keywords);
		} catch {
			keywords = el.dataset.fgClickKeyword || '';
		}
	} else {
		keywords = el.dataset.fgClickKeyword || '';
	}
	return normalizeGraphSearchClickConfig({
		searchScope: el.dataset.fgSearchScope as GraphSearchScope,
		includeInactive: el.dataset.fgSearchIncludeInactive === 'true',
		searchStrict: el.dataset.fgSearchStrict === 'true',
		firmRevealLimit: Number(el.dataset.fgClickFirmLimit),
		firmRevealPrevious: el.dataset.fgClickFirmPrevious === 'true',
		clickRevealKeywords: keywords as string[],
		clickRevealStrict: el.dataset.fgClickStrict === 'true',
	});
}
