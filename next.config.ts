import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The field app is a PWA: the service worker must be served from the root scope so it
  // can control every page, and it must never itself be cached.
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
};

export default config;
