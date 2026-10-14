const truthy = new Set(['1', 'true', 'yes', 'on']);

/** Request-scoped override set by cron / selection-refresh / build handlers. Not read from .env. */
let runtimeExternalApiContext: string | null = null;

function getFlagValue(...names: string[]) {
	for (const name of names) {
		const value = process.env[name];
		if (value == null) continue;
		const normalized = String(value).trim().toLowerCase();
		if (normalized === '') continue;
		return normalized;
	}
	return '';
}

function isExplicitlyDisabled() {
	const raw = getFlagValue('EXTERNAL_API_DISABLED', 'DISABLE_EXTERNAL_API_FETCH');
	return raw !== '' && truthy.has(raw);
}

export function getExternalApiContext() {
	return runtimeExternalApiContext || '';
}

export function canCallExternalApis() {
	const context = getExternalApiContext();
	// Deliberate server jobs may run even when ambient UI fetches are disabled.
	// Only runtime setExternalApiContext counts — ambient EXTERNAL_API_CONTEXT in .env does not.
	if (context === 'cronjob' || context === 'build' || context === 'selection-refresh' || context === 'search') {
		return true;
	}

	if (isExplicitlyDisabled()) return false;
	const enabled = getFlagValue('EXTERNAL_API_ENABLED');
	return enabled !== '' && truthy.has(enabled);
}

/**
 * Bounded BrokerCheck/IAPD name search may run even when detail fetches are disabled.
 * Opt out with EXTERNAL_SEARCH_DISABLED=1; force on with EXTERNAL_SEARCH_SUPPLEMENT=1.
 * Local development allows it by default so surname search can reach live coverage.
 */
export function canCallExternalSearchApis() {
	const searchDisabled = getFlagValue('EXTERNAL_SEARCH_DISABLED');
	if (searchDisabled !== '' && truthy.has(searchDisabled)) return false;
	if (canCallExternalApis()) return true;
	const supplement = getFlagValue('EXTERNAL_SEARCH_SUPPLEMENT', 'EXTERNAL_API_ENABLED');
	if (supplement !== '' && truthy.has(supplement)) return true;
	return process.env.NODE_ENV === 'development';
}

export function setExternalApiContext(context: string | null | undefined) {
	if (context == null || String(context).trim() === '') {
		runtimeExternalApiContext = null;
		return;
	}
	runtimeExternalApiContext = String(context).trim().toLowerCase();
}
