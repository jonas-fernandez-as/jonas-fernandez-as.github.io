import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://jonastrikex.com',
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
  },
});
