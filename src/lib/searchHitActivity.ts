export type HeaderSearchType = 'all' | 'people' | 'firms' | 'people-inactive' | 'firms-inactive';

export const HEADER_SEARCH_TYPES: HeaderSearchType[] = ['all', 'people', 'firms', 'people-inactive', 'firms-inactive'];

export function isHeaderSearchType(value: string | null | undefined): value is HeaderSearchType {
	return HEADER_SEARCH_TYPES.includes(String(value || '').trim().toLowerCase() as HeaderSearchType);
}

/** Aligns with finra-graph classifyActivityText for search-hit scope/status strings. */
export function classifySearchActivityText(value: unknown): 'active' | 'inactive' | null {
	const normalized = String(value || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '');
	if (!normalized) return null;
	if (
		/(inactive|terminated|revoked|suspended|notinscope|withdrawn|barred|expelled|denied|ceased|closed|cancelled|canceled|previouslyregistered|nolongerregistered|notregistered|expanded)/.test(
			normalized,
		)
	) {
		return 'inactive';
	}
	if (/(active|approved|current)/.test(normalized)) {
		return 'active';
	}
	return null;
}

function unwrapSearchHit(hit: any) {
	return hit?._source || hit || {};
}

function activityFlagsForHit(hit: any, kind: 'individual' | 'firm'): Array<'active' | 'inactive' | null> {
	const src = unwrapSearchHit(hit);
	const basic = src?.basicInformation && typeof src.basicInformation === 'object' ? src.basicInformation : {};
	if (kind === 'individual') {
		return [
			classifySearchActivityText(src.ind_bc_scope ?? basic.bcScope ?? src.bcScope),
			classifySearchActivityText(src.ind_ia_scope ?? basic.iaScope ?? src.iaScope),
		];
	}
	return [
		classifySearchActivityText(src.firm_bc_scope ?? basic.bcScope ?? src.bcScope),
		classifySearchActivityText(src.firm_ia_scope ?? basic.iaScope ?? src.iaScope),
		classifySearchActivityText(src.firmStatus ?? basic.firmStatus),
	];
}

/** True when the hit has at least one active registration signal. */
export function searchHitLooksActive(hit: any, kind: 'individual' | 'firm'): boolean {
	return activityFlagsForHit(hit, kind).includes('active');
}

/** True when the hit has inactive registration signals and no active ones. */
export function searchHitLooksInactive(hit: any, kind: 'individual' | 'firm'): boolean {
	const flags = activityFlagsForHit(hit, kind);
	if (flags.includes('active')) return false;
	return flags.includes('inactive');
}

export function searchTypeIncludesPeople(searchType: string) {
	const value = String(searchType || '').trim().toLowerCase();
	return value === 'all' || value === 'people' || value === 'people-inactive';
}

export function searchTypeIncludesFirms(searchType: string) {
	const value = String(searchType || '').trim().toLowerCase();
	return value === 'all' || value === 'firms' || value === 'firms-inactive';
}

/** People/Firms = active-only; People/Firms inactive = inactive-only. All = no activity filter. */
export function searchTypeActivityFilter(
	searchType: string,
): { kind: 'individual' | 'firm'; mode: 'active' | 'inactive' } | null {
	const value = String(searchType || '').trim().toLowerCase();
	if (value === 'people') return { kind: 'individual', mode: 'active' };
	if (value === 'people-inactive') return { kind: 'individual', mode: 'inactive' };
	if (value === 'firms') return { kind: 'firm', mode: 'active' };
	if (value === 'firms-inactive') return { kind: 'firm', mode: 'inactive' };
	return null;
}

export function searchTypeWantsInactiveOnly(searchType: string): 'individual' | 'firm' | null {
	const filter = searchTypeActivityFilter(searchType);
	return filter?.mode === 'inactive' ? filter.kind : null;
}

export function searchTypeWantsActiveOnly(searchType: string): 'individual' | 'firm' | null {
	const filter = searchTypeActivityFilter(searchType);
	return filter?.mode === 'active' ? filter.kind : null;
}

export function searchHitMatchesActivityFilter(
	hit: any,
	filter: { kind: 'individual' | 'firm'; mode: 'active' | 'inactive' },
): boolean {
	if (filter.mode === 'active') return searchHitLooksActive(hit, filter.kind);
	return searchHitLooksInactive(hit, filter.kind);
}
