/** Canvas/SVG firm fill+stroke from FINRA / SEC source coverage. */

import { enrichFirmSearchHitSource } from './searchHitActivity';

export type FirmSourceCoverage = 'both' | 'sec_only' | 'finra_only' | 'none';

/**
 * All firm nodes share one green palette (coverage no longer changes fill).
 * Selected = slightly darker; roster-exhausted = darker center + darker outline.
 */
export const FIRM_SEC_ONLY_FILL = '#14c2bb';
export const FIRM_SEC_ONLY_STROKE = '#00f5ff';
export const FIRM_SELECTED_FILL = '#0f766e';
export const FIRM_SELECTED_STROKE = '#2dd4bf';
/** Darker green center when no more current connections remain to reveal. */
export const FIRM_EXHAUSTED_FILL = '#0f766e';
/** Darker green outline for exhausted roster. */
export const FIRM_EXHAUSTED_STROKE = '#134e4a';
export const FIRM_EXHAUSTED_SELECTED_FILL = '#115e59';
export const FIRM_EXHAUSTED_SELECTED_STROKE = '#042f2e';

/** @deprecated Kept as aliases — all firms paint green now. */
export const FIRM_FINRA_ONLY_FILL = FIRM_SEC_ONLY_FILL;
const FIRM_FINRA_ONLY_STROKE = FIRM_SEC_ONLY_STROKE;
const FIRM_FINRA_ONLY_SELECTED_FILL = FIRM_SELECTED_FILL;
const FIRM_FINRA_ONLY_SELECTED_STROKE = FIRM_SELECTED_STROKE;

/** @deprecated Kept as aliases — all firms paint green now. */
export const FIRM_BOTH_FILL = FIRM_SEC_ONLY_FILL;
export const FIRM_BOTH_STROKE = FIRM_SEC_ONLY_STROKE;
const FIRM_BOTH_SELECTED_FILL = FIRM_SELECTED_FILL;
const FIRM_BOTH_SELECTED_STROKE = FIRM_SELECTED_STROKE;

const FIRM_SEC_ONLY_SELECTED_FILL = FIRM_SELECTED_FILL;
const FIRM_SEC_ONLY_SELECTED_STROKE = FIRM_SELECTED_STROKE;

/** True once firm roster expand has nothing left to add on a later click. */
export function isFirmRosterRevealExhausted(node: any): boolean {
	if (!node || node.group !== 'firm') return false;
	if (node._secOnlyCurrentConnectionsExpanded === true) return true;
	// Loaded empty roster: nothing left to reveal.
	if (node._connectionsLoaded === true) {
		const current = Array.isArray(node.currentConnections) ? node.currentConnections : [];
		if (current.length === 0) return true;
	}
	return false;
}

function isNotInScopeValue(value: unknown) {
	return (
		String(value || '')
			.trim()
			.toLowerCase()
			.replace(/\s+/g, '') === 'notinscope'
	);
}

function hasAnyItems(value: unknown) {
	return Array.isArray(value) && value.some((entry) => entry != null && entry !== '');
}

function hasActivitySignal(value: unknown) {
	const normalized = String(value || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '');
	if (!normalized || normalized === 'notinscope') return false;
	return /(active|inactive|approved|current|terminated|revoked|suspended|withdrawn|barred)/.test(normalized);
}

/** Lightweight firm FINRA presence for paint (aligned with graph sidebar signals). */
function firmHasFinraSource(node: any): boolean {
	if (!node || typeof node !== 'object') return false;
	if (
		Array.isArray(node.suppressedExternalLinks) &&
		node.suppressedExternalLinks.some((s: unknown) => String(s || '').trim().toLowerCase() === 'finra')
	) {
		return false;
	}
	if (isNotInScopeValue(node.bcScope) || isNotInScopeValue(node.basicInformation?.bcScope)) return false;
	if (node.hasFinraData === false) return false;
	if (node.hasFinraData === true) return true;
	if (node.isLegacy === 'Y') return true;
	if (hasAnyItems(node.selfRegulatoryOrgs)) return true;
	if (Boolean(String(node.districtName || '').trim())) return true;
	if (hasActivitySignal(node.bcScope) || hasActivitySignal(node.basicInformation?.bcScope)) return true;
	return false;
}

/** Lightweight firm SEC presence for paint. */
function firmHasSecSource(node: any): boolean {
	if (!node || typeof node !== 'object') return false;
	if (
		Array.isArray(node.suppressedExternalLinks) &&
		node.suppressedExternalLinks.some((s: unknown) => String(s || '').trim().toLowerCase() === 'sec')
	) {
		return false;
	}
	if (isNotInScopeValue(node.iaScope) || isNotInScopeValue(node.basicInformation?.iaScope)) return false;
	if (node.hasSecData === false) return false;
	if (node.hasSecData === true) return true;
	if (Boolean(String(node.iaSecNumber || node.basicInformation?.iaSECNumber || node.basicInformation?.iaSecNumber || '').trim())) {
		return true;
	}
	if (hasAnyItems(node.secDocumentLinks)) return true;
	if (Boolean(String(node.secSummaryDescription || '').trim())) return true;
	// firmStatus is a BrokerCheck/BD field — do not treat it as SEC/IA coverage.
	if (hasActivitySignal(node.iaScope) || hasActivitySignal(node.basicInformation?.iaScope)) return true;
	return false;
}

export function getFirmSourceCoverage(node: any): FirmSourceCoverage {
	const finra = firmHasFinraSource(node);
	const sec = firmHasSecSource(node);
	if (finra && sec) return 'both';
	if (sec) return 'sec_only';
	if (finra) return 'finra_only';
	return 'none';
}

export type FirmSourceFieldSnapshot = {
	bcScope: string | null;
	iaScope: string | null;
	firmStatus: string | null;
	iaSecNumber: string | null;
	bdSecNumber: string | null;
	hasFinraData: boolean;
	hasSecData: boolean;
	basicInformation?: Record<string, any>;
	districtName?: string | null;
	isLegacy?: string | null;
	selfRegulatoryOrgs?: any[];
};

function firstNonEmptyString(...values: unknown[]) {
	for (const value of values) {
		const text = String(value || '').trim();
		if (text) return text;
	}
	return null;
}

/**
 * Normalize firm search hits / detail payloads into the fields graph paint needs.
 * Search/detail often use `iaSECNumber` (capital SEC) while the canvas reads `iaSecNumber`.
 */
export function extractFirmSourceFields(src: any): FirmSourceFieldSnapshot {
	const enriched = enrichFirmSearchHitSource(src && typeof src === 'object' ? src : {}, src?.normalizedStrictSearchText || src?.strictSearchText);
	const bi = enriched?.basicInformation && typeof enriched.basicInformation === 'object' ? { ...enriched.basicInformation } : {};
	const bcScope = firstNonEmptyString(bi.bcScope, enriched.firm_bc_scope, enriched.bcScope);
	const iaScope = firstNonEmptyString(bi.iaScope, enriched.firm_ia_scope, enriched.iaScope);
	const firmStatus = firstNonEmptyString(bi.firmStatus, enriched.firmStatus);
	const iaSecNumber = firstNonEmptyString(
		enriched.firm_ia_sec_number,
		enriched.iaSecNumber,
		enriched.iaSECNumber,
		bi.iaSECNumber,
		bi.iaSecNumber,
	);
	const bdSecNumber = firstNonEmptyString(
		enriched.firm_bd_sec_number,
		enriched.bdSecNumber,
		enriched.bdSECNumber,
		bi.bdSECNumber,
		bi.bdSecNumber,
	);
	const districtName = firstNonEmptyString(bi.districtName, enriched.districtName);
	const isLegacy = firstNonEmptyString(bi.isLegacy, enriched.isLegacy);
	const selfRegulatoryOrgs = Array.isArray(enriched.selfRegulatoryOrgs)
		? enriched.selfRegulatoryOrgs
		: Array.isArray(enriched.SROs)
			? enriched.SROs
			: undefined;

	const explicitFinra =
		typeof enriched.hasFinraData === 'boolean' ? enriched.hasFinraData
		: typeof src?.hasFinraData === 'boolean' ? src.hasFinraData
		: null;
	const explicitSec =
		typeof enriched.hasSecData === 'boolean' ? enriched.hasSecData
		: typeof src?.hasSecData === 'boolean' ? src.hasSecData
		: null;

	const probe = {
		bcScope,
		iaScope,
		firmStatus,
		iaSecNumber,
		bdSecNumber,
		districtName,
		isLegacy,
		selfRegulatoryOrgs,
		basicInformation: Object.keys(bi).length ? bi : undefined,
	};
	return {
		bcScope,
		iaScope,
		firmStatus,
		iaSecNumber,
		bdSecNumber,
		districtName,
		isLegacy,
		selfRegulatoryOrgs,
		basicInformation: Object.keys(bi).length ? bi : undefined,
		hasFinraData: explicitFinra != null ? explicitFinra : firmHasFinraSource(probe),
		hasSecData: explicitSec != null ? explicitSec : firmHasSecSource(probe),
	};
}

/** Merge extractFirmSourceFields onto an existing firm node (fetch / hydrate). */
export function applyFirmSourceFieldsToNode(node: any, src: any) {
	if (!node || typeof node !== 'object') return node;
	const fields = extractFirmSourceFields(src);
	if (fields.bcScope) node.bcScope = fields.bcScope;
	if (fields.iaScope) node.iaScope = fields.iaScope;
	if (fields.firmStatus) node.firmStatus = fields.firmStatus;
	// Stamp SEC/BD numbers from the source snapshot. When the source has no IA SEC
	// number (or explicitly hasSecData=false), clear any stale iaSecNumber so a prior
	// bad hydrate (bdSECNumber copied onto iaSecNumber) cannot invent SEC coverage.
	if (fields.iaSecNumber) node.iaSecNumber = fields.iaSecNumber;
	else if (fields.hasSecData === false || Object.prototype.hasOwnProperty.call(src || {}, 'basicInformation') || src?.hasSecData === false) {
		node.iaSecNumber = null;
	}
	if (fields.bdSecNumber) node.bdSecNumber = fields.bdSecNumber;
	if (fields.districtName) node.districtName = fields.districtName;
	if (fields.isLegacy) node.isLegacy = fields.isLegacy;
	if (fields.selfRegulatoryOrgs?.length) node.selfRegulatoryOrgs = fields.selfRegulatoryOrgs;
	if (fields.basicInformation) {
		node.basicInformation =
			node.basicInformation && typeof node.basicInformation === 'object' ?
				{ ...fields.basicInformation, ...node.basicInformation }
			:	{ ...fields.basicInformation };
	}
	node.hasFinraData = fields.hasFinraData;
	node.hasSecData = fields.hasSecData;
	if (fields.hasSecData === false) {
		node.iaSecNumber = null;
		if (node.basicInformation && typeof node.basicInformation === 'object') {
			delete node.basicInformation.iaSECNumber;
			delete node.basicInformation.iaSecNumber;
		}
	}
	return node;
}

export type FirmSourcePaintStyle = {
	coverage: FirmSourceCoverage;
	fill: string | null;
	stroke: string | null;
	/** CSS modifier class for SVG firm nodes. */
	className: string | null;
	exhausted?: boolean;
};

/**
 * Fill/stroke for graph firm nodes.
 * All active firms use the same green; selected is darker; exhausted roster is
 * darker center + darker outline. Coverage is still returned for sidebar/summary.
 */
export function getFirmSourcePaintStyle(
	node: any,
	options: { selected?: boolean } = {},
): FirmSourcePaintStyle {
	const selected = Boolean(options.selected);
	const coverage = getFirmSourceCoverage(node);
	const exhausted = isFirmRosterRevealExhausted(node);
	let fill: string = FIRM_SEC_ONLY_FILL;
	let stroke: string = FIRM_SEC_ONLY_STROKE;
	if (exhausted && selected) {
		fill = FIRM_EXHAUSTED_SELECTED_FILL;
		stroke = FIRM_EXHAUSTED_SELECTED_STROKE;
	} else if (exhausted) {
		fill = FIRM_EXHAUSTED_FILL;
		stroke = FIRM_EXHAUSTED_STROKE;
	} else if (selected) {
		fill = FIRM_SELECTED_FILL;
		stroke = FIRM_SELECTED_STROKE;
	}
	const className =
		exhausted ? 'fg-node--firm-green fg-node--roster-exhausted'
		:	'fg-node--firm-green';
	return { coverage, fill, stroke, className, exhausted };
}


