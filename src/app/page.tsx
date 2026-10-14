'use client';
import dynamic from 'next/dynamic';

const FinraGraph = dynamic(() => import('@/components/FinraGraph'), {
	ssr: false,
	loading: () => (
		<div id='finra-app' className='fg-app-loading'>
			<header className='fg-header'>
				<div className='fg-header-bar'></div>
			</header>
			<main className='fg-main fg-loading-main'>
				<div className='fg-empty-card'>
					<p className='fg-empty-eyebrow'>Loading graph…</p>
				</div>
			</main>
		</div>
	),
});

export default function HomePage() {
	return <FinraGraph />;
}
