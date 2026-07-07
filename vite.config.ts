import { defineConfig } from 'vite';

// BASE_PATH is set by CI when deploying to GitHub Pages (/universe/).
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
});
