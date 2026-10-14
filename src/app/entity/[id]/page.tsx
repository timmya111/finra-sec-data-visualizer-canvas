'use client';
import dynamic from 'next/dynamic';

const FinraGraph = dynamic(() => import('@/components/FinraGraph'), {
	ssr: false,
	loading: () => (
		<div className='fg-loading-shell'>
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

export default function EntityRoutePage() {
	return <FinraGraph />;
}
