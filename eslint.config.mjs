import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '.agents/**',
      '.codex/**',
      '.aws/**',
      '.skills/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['**/*.ts', '**/*.mjs', '**/*.cjs'],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
);
