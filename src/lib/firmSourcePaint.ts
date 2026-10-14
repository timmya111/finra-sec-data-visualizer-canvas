/** Canvas/SVG firm fill+stroke from FINRA / SEC source coverage. */

export type FirmSourceCoverage = 'both' | 'sec_only' | 'finra_only' | 'none';

/** SEC-only firm fill — keep the existing connected-firm green. */
export const FIRM_SEC_ONLY_FILL = '#14c2bb';
export const FIRM_SEC_ONLY_STROKE = '#00f5ff';
export const FIRM_SEC_ONLY_SELECTED_FILL = '#0f766e';
export const FIRM_SEC_ONLY_SELECTED_STROKE = '#2dd4bf';

/**
 * FINRA-only firm fill — purple at roughly the same relative luminance as
 * FIRM_SEC_ONLY_FILL (#14c2bb ≈ 0.42).
 */
export const FIRM_FINRA_ONLY_FILL = '#e879f9';
export const FIRM_FINRA_ONLY_STROKE = '#f5d0fe';
export const FIRM_FINRA_ONLY_SELECTED_FILL = '#a21caf';
export const FIRM_FINRA_ONLY_SELECTED_STROKE = '#f0abfc';

/** Dual-coverage: same purple fill as FINRA-only, green border to signal SEC. */
export const FIRM_BOTH_FILL = FIRM_FINRA_ONLY_FILL;
export const FIRM_BOTH_STROKE = FIRM_SEC_ONLY_FILL;
export const FIRM_BOTH_SELECTED_FILL = FIRM_FINRA_ONLY_SELECTED_FILL;
export const FIRM_BOTH_SELECTED_STROKE = FIRM_SEC_ONLY_FILL;

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

function firmIdOf(node: any) {
	return String(node?.firmId || node?.id || '')
		.replace(/^firm[:_]/i, '')
		.replace(/^node[:_]/i, '')
		.trim();
}

/** Lightweight firm FINRA presence for paint (aligned with graph sidebar signals). */
export function firmHasFinraSource(node: any): boolean {
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
export function firmHasSecSource(node: any): boolean {
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
	if (hasActivitySignal(node.iaScope) || hasActivitySignal(node.basicInformation?.iaScope)) return true;
	if (hasActivitySignal(node.firmStatus) || hasActivitySignal(node.basicInformation?.firmStatus)) return true;
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

export type FirmSourcePaintStyle = {
	coverage: FirmSourceCoverage;
	fill: string | null;
	stroke: string | null;
	/** CSS modifier class for SVG firm nodes. */
	className: string | null;
};

/**
 * Fill/stroke for graph firm nodes.
 * When coverage is known, returns source colors. When `none`, returns null fills so
 * callers keep their existing default / connected fallback.
 */
export function getFirmSourcePaintStyle(
	node: any,
	options: { selected?: boolean } = {},
): FirmSourcePaintStyle {
	const selected = Boolean(options.selected);
	const coverage = getFirmSourceCoverage(node);
	if (coverage === 'sec_only') {
		return {
			coverage,
			fill: selected ? FIRM_SEC_ONLY_SELECTED_FILL : FIRM_SEC_ONLY_FILL,
			stroke: selected ? FIRM_SEC_ONLY_SELECTED_STROKE : FIRM_SEC_ONLY_STROKE,
			className: 'fg-node--sec-only',
		};
	}
	if (coverage === 'finra_only') {
		return {
			coverage,
			fill: selected ? FIRM_FINRA_ONLY_SELECTED_FILL : FIRM_FINRA_ONLY_FILL,
			stroke: selected ? FIRM_FINRA_ONLY_SELECTED_STROKE : FIRM_FINRA_ONLY_STROKE,
			className: 'fg-node--finra-only',
		};
	}
	if (coverage === 'both') {
		return {
			coverage,
			fill: selected ? FIRM_BOTH_SELECTED_FILL : FIRM_BOTH_FILL,
			stroke: selected ? FIRM_BOTH_SELECTED_STROKE : FIRM_BOTH_STROKE,
			className: 'fg-node--finra-sec',
		};
	}
	return { coverage, fill: null, stroke: null, className: null };
}

export function firmSourceCssClass(node: any): string | null {
	return getFirmSourcePaintStyle(node).className;
}

/** Debug/helper: whether a numeric firm id is present (unused in paint, kept for tests). */
export function firmHasNumericId(node: any) {
	return /^\d+$/.test(firmIdOf(node));
}
