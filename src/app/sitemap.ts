import type { MetadataRoute } from 'next';

const siteUrl = 'https://finra-sec-data-visualizer-canvas.vercel.app';

export default function sitemap(): MetadataRoute.Sitemap {
	const now = new Date();

	return [
		{
			url: siteUrl,
			lastModified: now,
			changeFrequency: 'daily',
			priority: 1,
		},
	];
}
