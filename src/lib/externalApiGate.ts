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
	if (context === 'cronjob' || context === 'build' || context === 'selection-refresh') {
		return true;
	}

	if (isExplicitlyDisabled()) return false;
	return false;
}

export function setExternalApiContext(context: string | null | undefined) {
	if (context == null || String(context).trim() === '') {
		runtimeExternalApiContext = null;
		return;
	}
	runtimeExternalApiContext = String(context).trim().toLowerCase();
}
