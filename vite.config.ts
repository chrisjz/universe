import { defineConfig } from 'vite';

// The site lives at the domain root (universeatlas.org); BASE_PATH remains
// as an override for deploying under a subpath.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
});
