'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

function isLoopbackHost(hostname: string): boolean {
	const host = String(hostname || '')
		.trim()
		.toLowerCase();
	return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * Fixed bottom-left nav chip for localhost-only pages (graph ↔ local AI).
 */
export default function LocalOnlyCornerLink({
	href,
	label,
	title,
}: {
	href: string;
	label: string;
	title?: string;
}) {
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		setVisible(isLoopbackHost(window.location.hostname));
	}, []);

	if (!visible) return null;

	return (
		<Link
			href={href}
			prefetch={false}
			className='fg-local-corner-link'
			title={title || label}
			aria-label={title || label}>
			{label}
		</Link>
	);
}
