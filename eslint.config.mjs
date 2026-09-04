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
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
