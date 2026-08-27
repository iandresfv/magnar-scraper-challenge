import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'data/**', 'exports/**', 'reports/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    // Config files are plain JS and live outside tsconfig's `include`; type-aware rules
    // have nothing to work with there.
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // eslint.config.js is plain JS and deliberately outside tsconfig's `include`;
          // the default project lets the parser handle it without type-aware rules.
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // The hexagonal dependency rule of v2 3.1. test/arch/imports.test.ts enforces the
      // same invariant over the real import graph; this is the fast feedback loop.
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': 'off',
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/sites/**', '**/infra/**', '**/app/**'],
              message: 'core/ must not import sites/, infra/ or app/ (hexagonal rule, v2 3.1).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/sites/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/infra/**', '**/app/**'],
              message: 'sites/ must not import infra/ or app/ (hexagonal rule, v2 3.1).',
            },
          ],
        },
      ],
    },
  },
);
