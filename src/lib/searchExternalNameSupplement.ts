import type { LocalSearchResponse } from './localSearch';
import { canCallExternalSearchApis } from './externalApiGate';

const EXTERNAL_PAGE_SIZE = 100;
const EXTERNAL_MAX_PAGES = 10;
const EXTERNAL_EMPTY_PAGE_STOP = 2;

function normalizeToken(value: unknown) {
	return String(value || '')
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function tokenize(value: unknown) {
	return normalizeToken(value)
		.split(' ')
		.map((token) => token.trim())
		.filter(Boolean);
}

function getBoundedEditDistance(left: string, right: string, maxDistance: number) {
	if (left === right) return 0;
	if (!left || !right) return maxDistance + 1;
	const m = left.length;
	const n = right.length;
	if (Math.abs(m - n) > maxDistance) return maxDistance + 1;
	const prev = Array.from({ length: n + 1 }, (_, index) => index);
	for (let i = 1; i <= m; i += 1) {
		let diagonal = prev[0];
		prev[0] = i;
		let rowMin = i;
		for (let j = 1; j <= n; j += 1) {
			const temp = prev[j];
			const cost = left[i - 1] === right[j - 1] ? 0 : 1;
			prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + cost);
			diagonal = temp;
			if (prev[j] < rowMin) rowMin = prev[j];
		}
		if (rowMin > maxDistance) return maxDistance + 1;
	}
	return prev[n];
}

/** Same spirit as localSearch tokensFuzzyMatch — keep BrokerCheck Cooper/Topper noise out. */
export function tokensFuzzyMatch(queryToken: string, candidateToken: string) {
	if (!queryToken || !candidateToken) return false;
	if (queryToken === candidateToken) return true;
	if (candidateToken.includes(queryToken) && queryToken.length >= 3) return true;
	if (queryToken.includes(candidateToken) && candidateToken.length >= 3) return true;
	const minLength = Math.min(queryToken.length, candidateToken.length);
	if (minLength < 3) return false;
	const maxDistance = Math.max(1, Math.floor(queryToken.length * 0.3));
	if (Math.abs(queryToken.length - candidateToken.length) > maxDistance) return false;
	if (queryToken[0] !== candidateToken[0] && queryToken[0] !== candidateToken[1] && queryToken[1] !== candidateToken[0]) {
		return false;
	}
	return getBoundedEditDistance(queryToken, candidateToken, maxDistance) <= maxDistance;
}

function collectHitNameTokens(hit: any) {
	const source = hit?._source || hit || {};
	const basic = source.basicInformation && typeof source.basicInformation === 'object' ? source.basicInformation : {};
	const parts = [
		source.ind_firstname,
		source.ind_middlename,
		source.ind_lastname,
		source.ind_other_names,
		source.otherNames,
		basic.firstName,
		basic.middleName,
		basic.lastName,
		basic.otherNames,
		source.firm_name,
		source.firmName,
		basic.firmName,
		source.name,
		source.label,
	];
	const tokens = new Set<string>();
	for (const part of parts) {
		if (Array.isArray(part)) {
			for (const entry of part) tokenize(entry).forEach((token) => tokens.add(token));
		} else {
			tokenize(part).forEach((token) => tokens.add(token));
		}
	}
	return tokens;
}

export function externalHitMatchesNameQuery(hit: any, query: string) {
	const queryTokens = tokenize(query);
	if (!queryTokens.length) return false;
	const nameTokens = collectHitNameTokens(hit);
	if (!nameTokens.size) return false;
	return queryTokens.every((queryToken) => {
		for (const candidate of nameTokens) {
			if (candidate.startsWith(queryToken) && queryToken.length >= 3) return true;
			if (tokensFuzzyMatch(queryToken, candidate)) return true;
		}
		return false;
	});
}

function getHitCrd(hit: any, entity: 'individual' | 'firm') {
	const source = hit?._source || hit || {};
	if (entity === 'individual') {
		return String(source.ind_source_id || source.ind_crd || source.basicInformation?.individualId || '').trim();
	}
	return String(source.firm_source_id || source.firm_id || source.firmId || source.basicInformation?.firmId || '').trim();
}

function toLocalSearchResponse(
	source: 'finra' | 'sec',
	entity: 'individual' | 'firm',
	results: any[],
	options: { limit: number; offset: number },
): LocalSearchResponse {
	const { limit, offset } = options;
	const total = results.length;
	const page = limit > 0 ? results.slice(offset, offset + limit) : results;
	return {
		bucket: `${source}:${entity}`,
		generatedAt: new Date().toISOString(),
		total,
		hits: {
			total,
			start: offset,
			hits: page.map((doc) => ({
				_id: String(doc?.id || doc?.ind_source_id || doc?.firm_source_id || ''),
				_source: doc,
			})),
		},
		response: {
			numFound: total,
			start: offset,
			docs: page,
		},
		results: page,
		currentPage: page,
		pageNumber: limit > 0 ? Math.floor(offset / limit) + 1 : 1,
		pageSize: limit,
	};
}

/**
 * Page BrokerCheck/IAPD and keep only name fuzzy/prefix matches.
 * BrokerCheck's raw `hopper` query returns thousands of loose hits (Cooper, etc.);
 * this filter keeps Hopper/Hooper/Hoppe-style surnames.
 */
export async function searchExternalNameSupplement(
	source: 'finra' | 'sec',
	entity: 'individual' | 'firm',
	query: string,
	options: { limit?: number; offset?: number; maxPages?: number } = {},
): Promise<LocalSearchResponse | null> {
	if (!canCallExternalSearchApis()) return null;
	const trimmed = String(query || '').trim();
	if (!trimmed || /^\d{1,10}$/.test(trimmed)) return null;

	const limit = Math.max(0, Math.min(options.limit ?? 1000, 1000));
	const offset = Math.max(0, options.offset ?? 0);
	const maxPages = Math.max(1, Math.min(options.maxPages ?? EXTERNAL_MAX_PAGES, 20));
	const encoded = encodeURIComponent(trimmed);
	const fetchOptions = {
		headers: {
			Accept: 'application/json',
			'User-Agent':
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			Referer: source === 'finra' ? 'https://brokercheck.finra.org/' : 'https://adviserinfo.sec.gov/',
		},
	};

	const matched: any[] = [];
	const seenIds = new Set<string>();
	let emptyMatchPages = 0;

	try {
		for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
			const start = pageIndex * EXTERNAL_PAGE_SIZE;
			const queryParams =
				entity === 'individual' ?
					`hl=true&includePrevious=true&nrows=${EXTERNAL_PAGE_SIZE}&start=${start}&wt=json`
				:	`hl=true&nrows=${EXTERNAL_PAGE_SIZE}&start=${start}&wt=json`;
			const url =
				source === 'finra' ?
					`https://api.brokercheck.finra.org/search/${entity}?query=${encoded}&${queryParams}`
				:	`https://api.adviserinfo.sec.gov/search/${entity}?query=${encoded}&${queryParams}`;

			const res = await fetch(url, fetchOptions);
			if (!res.ok) break;
			const externalData = await res.json();
			const hits = externalData?.hits?.hits || [];
			if (!hits.length) break;

			let pageMatches = 0;
			for (const hit of hits) {
				if (!externalHitMatchesNameQuery(hit, trimmed)) continue;
				const sourceDoc = hit?._source || hit || {};
				const crd = getHitCrd(hit, entity);
				if (!crd || seenIds.has(crd)) continue;
				seenIds.add(crd);
				pageMatches += 1;
				matched.push({
					...sourceDoc,
					...(entity === 'individual' ?
						{ ind_source_id: sourceDoc.ind_source_id || crd, ind_crd: sourceDoc.ind_crd || crd, id: crd }
					:	{ firm_source_id: sourceDoc.firm_source_id || crd, firm_id: sourceDoc.firm_id || crd, id: crd }),
				});
			}

			if (pageMatches === 0) {
				emptyMatchPages += 1;
				if (emptyMatchPages >= EXTERNAL_EMPTY_PAGE_STOP && matched.length > 0) break;
			} else {
				emptyMatchPages = 0;
			}

			const claimedTotal = Number(externalData?.hits?.total || 0);
			if (start + hits.length >= claimedTotal) break;
		}
	} catch (err: any) {
		console.warn(`[searchExternalNameSupplement] failed for ${source}:${entity}:${trimmed}`, err?.message || err);
		if (!matched.length) return null;
	}

	if (!matched.length) return null;
	return toLocalSearchResponse(source, entity, matched, { limit, offset });
}
