/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: { '/events': ['./seed/events-all.json'], '/api/calendar.ics': ['./seed/events-all.json'] },
  // ws must stay a real node module: bundled, its frame masking breaks ("b.mask is not a function") and the Live API
  // socket used by /api/translate (gemini-3.5-live-translate-preview) closes instantly.
  serverExternalPackages: ['ws'],
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
