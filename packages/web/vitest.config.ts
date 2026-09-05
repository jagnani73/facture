import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

/**
 * The web package runs under Vite rather than Next for tests, so two things Next supplies
 * implicitly have to be stated: the `@/*` alias, which comes from `tsconfig.json` via
 * `vite-tsconfig-paths` so the two can never disagree, and the JSX transform.
 *
 * `css: false` is the default and is left alone deliberately — CSS is never transformed, so
 * `postcss.config.mjs` and Tailwind stay out of the test run entirely.
 */
export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    // jsdom for every file rather than per-suite: the decoder tests do not need a DOM and
    // do not care that there is one, and one environment is one less thing to get wrong.
    environment: 'jsdom',
  },
});
