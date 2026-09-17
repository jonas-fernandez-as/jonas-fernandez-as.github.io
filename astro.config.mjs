import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://jonas-fernandez-as.github.io',
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
  },
});
