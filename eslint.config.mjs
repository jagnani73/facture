import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Build output and generated declarations. `next-env.d.ts` is committed by Next's own
    // convention but is still machine-written - it says "This file should not be edited" at the
    // top and is regenerated on every `next dev` / `next build`. Its triple-slash references
    // trip `@typescript-eslint/triple-slash-reference`, and the only fixes available are editing
    // a generated file or pinning a disable comment that Next would overwrite. Ignoring it is
    // the honest option.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/next-env.d.ts',
      '**/artifacts/**',
      '**/typechain-types/**',
      '**/cache/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    /*
     * Provisioning scripts are plain ESM run by `node` directly, so they get no
     * globals from a tsconfig the way `packages/contracts/scripts/*.ts` do — and
     * `no-undef` would flag every `process`, `console` and `fetch` in them.
     * Declared explicitly rather than by adding a `globals` dependency for six
     * names, and scoped to any `scripts/` directory — the root one and the
     * contracts package's — so nothing outside a script directory inherits it.
     */
    files: ['**/scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
