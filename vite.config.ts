import { defineConfig } from 'vite';

// GitHub Pages serves this repo from https://<user>.github.io/glass-glide/,
// so production assets need the '/glass-glide/' base. Local dev/preview stay
// at '/' for convenience.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/glass-glide/' : '/',
}));
