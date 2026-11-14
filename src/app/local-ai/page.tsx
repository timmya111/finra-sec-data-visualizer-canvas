import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { isLocalAiHost } from '@/lib/localAi/guard';
import LocalAiClient from '@/app/local-ai/LocalAiClient';

export const metadata: Metadata = {
	title: 'Local AI (Ollama)',
	robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function LocalAiPage() {
	const h = await headers();
	const host = h.get('x-forwarded-host') || h.get('host');
	if (!isLocalAiHost(host) && process.env.ALLOW_LOCAL_AI !== '1') {
		return (
			<main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 720 }}>
				<h1>Local AI</h1>
				<p>This page is available on <code>localhost</code> only.</p>
			</main>
		);
	}

	return <LocalAiClient />;
}
