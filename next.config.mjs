/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: { '/events': ['./seed/events-all.json'], '/api/calendar.ics': ['./seed/events-all.json'] },
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
