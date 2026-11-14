import fs from 'fs';
import path from 'path';

export type CrdYearStatRow = {
	year: number;
	peopleNew: number;
	peopleDisabledTerminated: number;
	firmsNew?: number;
	firmsDisabledTerminated?: number;
};

export type CrdYearStatsReport = {
	generatedAt?: string;
	source?: string;
	definitions?: Record<string, unknown>;
	totals?: Record<string, number | null>;
	byYear: CrdYearStatRow[];
	outsideOrUnknown?: Record<string, number>;
	chartPath?: string;
};

const CANDIDATE_PATHS = [
	path.join(process.cwd(), '.local', 'crd-year-stats-all.json'),
	path.join(process.cwd(), 'data', 'local-ai', 'crd-year-stats-all.json'),
	path.join(process.cwd(), '.local', 'crd-year-stats-2016-2026.json'),
	path.join(process.cwd(), 'data', 'local-ai', 'crd-year-stats-2016-2026.json'),
];

export function getCrdYearStatsPaths(): string[] {
	return CANDIDATE_PATHS;
}

export function loadCachedCrdYearStats(): { report: CrdYearStatsReport | null; path: string | null } {
	for (const p of CANDIDATE_PATHS) {
		try {
			if (!fs.existsSync(p)) continue;
			const report = JSON.parse(fs.readFileSync(p, 'utf8')) as CrdYearStatsReport;
			if (!report || !Array.isArray(report.byYear) || !report.byYear.length) continue;
			return { report, path: p };
		} catch {
			/* try next */
		}
	}
	return { report: null, path: null };
}

function clampYear(value: unknown, fallback: number | null): number | null {
	if (value == null || value === '') return fallback;
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(1900, Math.min(2100, Math.round(n)));
}

/**
 * Yearly census from the precomputed local Redis report (all years by default).
 * Full Redis rescan is too slow for chat — refresh via `.local/tmp-crd-year-stats.ts`.
 */
export function getPeopleCrdYearStats(options?: {
	fromYear?: number;
	toYear?: number;
	includeFirms?: boolean;
}): {
	ok: boolean;
	result: Record<string, unknown>;
} {
	const { report, path: cachePath } = loadCachedCrdYearStats();
	if (!report) {
		return {
			ok: false,
			result: {
				error: 'crd year stats cache missing',
				hint: 'Run: npx tsx --env-file=.env.local .local/tmp-crd-year-stats.ts (USE_LOCAL_REDIS=1). Writes .local/crd-year-stats-all.json',
			},
		};
	}

	const yearsInReport = report.byYear.map((r) => r.year).filter((y) => Number.isFinite(y));
	const reportMin = yearsInReport.length ? Math.min(...yearsInReport) : 1900;
	const reportMax = yearsInReport.length ? Math.max(...yearsInReport) : 2100;
	const fromYear = clampYear(options?.fromYear, reportMin) ?? reportMin;
	const toYear = clampYear(options?.toYear, reportMax) ?? reportMax;
	const lo = Math.min(fromYear, toYear);
	const hi = Math.max(fromYear, toYear);
	const includeFirms = options?.includeFirms !== false;

	const rows = report.byYear
		.filter((r) => r && r.year >= lo && r.year <= hi)
		.map((r) => ({
			year: r.year,
			peopleNew: Number(r.peopleNew) || 0,
			peopleDisabledTerminated: Number(r.peopleDisabledTerminated) || 0,
			firmsNew: Number(r.firmsNew) || 0,
			firmsDisabledTerminated: Number(r.firmsDisabledTerminated) || 0,
		}));

	const chartSvg = path.join(process.cwd(), 'public', 'people-crd-year-stats-all.svg');
	const chartPng = path.join(process.cwd(), 'public', 'people-crd-year-stats-all.png');
	const chartExists = fs.existsSync(chartSvg) || fs.existsSync(chartPng);

	const peopleNewTotal = rows.reduce((s, r) => s + r.peopleNew, 0);
	const peopleDisabledTotal = rows.reduce((s, r) => s + r.peopleDisabledTerminated, 0);
	const firmsNewTotal = rows.reduce((s, r) => s + r.firmsNew, 0);
	const firmsDisabledTotal = rows.reduce((s, r) => s + r.firmsDisabledTerminated, 0);

	const header = includeFirms
		? 'Year | People first-reg begin | People inactive/term end | Firms formedDate | Firms status end'
		: 'Year | People first-reg begin | People inactive/term end';
	const sep = includeFirms
		? '-----|------------------------|--------------------------|------------------|------------------'
		: '-----|------------------------|--------------------------';
	const lines = rows.map((r) =>
		includeFirms
			? `${r.year} | ${String(r.peopleNew).padStart(22)} | ${String(r.peopleDisabledTerminated).padStart(24)} | ${String(r.firmsNew).padStart(16)} | ${String(r.firmsDisabledTerminated).padStart(16)}`
			: `${r.year} | ${String(r.peopleNew).padStart(22)} | ${String(r.peopleDisabledTerminated).padStart(24)}`,
	);
	const tot = includeFirms
		? `TOT  | ${String(peopleNewTotal).padStart(22)} | ${String(peopleDisabledTotal).padStart(24)} | ${String(firmsNewTotal).padStart(16)} | ${String(firmsDisabledTotal).padStart(16)}`
		: `TOT  | ${String(peopleNewTotal).padStart(22)} | ${String(peopleDisabledTotal).padStart(24)}`;

	return {
		ok: true,
		result: {
			ok: true,
			entity: includeFirms ? 'people+firms' : 'people',
			fromYear: lo,
			toYear: hi,
			yearCount: rows.length,
			cachePath,
			generatedAt: report.generatedAt || null,
			source: report.source || 'local Redis cache report',
			uniquePeopleInCache: report.totals?.uniquePeople ?? null,
			uniqueFirmsInCache: report.totals?.uniqueFirms ?? null,
			peopleCurrentlyDisabled: report.totals?.peopleCurrentlyDisabled ?? null,
			firmsCurrentlyDisabled: report.totals?.firmsCurrentlyDisabled ?? null,
			definitions: {
				peopleFirstRegistrationBegin:
					report.definitions?.personNew ||
					'year of earliest employment registrationBeginDate (not CRD issuance year)',
				peopleInactiveOrTerminatedEnd:
					report.definitions?.personDisabled ||
					'inactive/terminated scope; year of latest registrationEndDate',
				firmsCorporateFormedDate:
					report.definitions?.firmNew ||
					'year of basicInformation.formedDate (corporate founding — can be 1900s; not CRD creation)',
				firmsStatusEndDate:
					report.definitions?.firmDisabled ||
					'terminated/inactive/revoked status; year of firmStatusDate',
				scope: report.definitions?.scope || 'Unique CRDs in local Redis only',
				caveat:
					'Early firm years (e.g. 1900 Stifel formedDate) are corporate formation dates from BrokerCheck, not when a CRD number was created.',
			},
			columnMeanings: {
				peopleNew: 'peopleFirstRegistrationBegin',
				peopleDisabledTerminated: 'peopleInactiveOrTerminatedEnd',
				firmsNew: 'firmsCorporateFormedDate',
				firmsDisabledTerminated: 'firmsStatusEndDate',
			},
			byYear: includeFirms
				? rows
				: rows.map(({ year, peopleNew, peopleDisabledTerminated }) => ({
						year,
						peopleNew,
						peopleDisabledTerminated,
					})),
			totalsInWindow: {
				peopleNew: peopleNewTotal,
				peopleDisabledTerminated: peopleDisabledTotal,
				...(includeFirms
					? { firmsNew: firmsNewTotal, firmsDisabledTerminated: firmsDisabledTotal }
					: {}),
			},
			outsideOrUnknown: report.outsideOrUnknown || null,
			chart: chartExists
				? {
						svg: '/people-crd-year-stats-all.svg',
						png: '/people-crd-year-stats-all.png',
						note: 'Full-year chart on localhost / public/people-crd-year-stats-all.*',
					}
				: null,
			asciiTable: [header, sep, ...lines, tot].join('\n'),
			refreshHint:
				'Cache is offline-precomputed from local Redis. Refresh with: npx tsx --env-file=.env.local .local/tmp-crd-year-stats.ts',
		},
	};
}
