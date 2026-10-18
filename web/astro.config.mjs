import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

export default defineConfig({
  integrations: [react()],
  vite: {
    server: {
      // Teruskan /api ke backend Rust saat development
      proxy: { '/api': 'http://127.0.0.1:8080' },
    },
  },
});
