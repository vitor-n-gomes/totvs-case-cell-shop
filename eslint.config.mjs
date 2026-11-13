import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import globals from 'globals';

const localStylePlugin = {
  rules: {
    'decorator-property-newline': {
      meta: {
        type: 'layout',
        docs: {
          description:
            'Require decorated class properties to start on the line after their decorators',
        },
        fixable: 'whitespace',
        schema: [],
        messages: {
          newline: 'Put the decorated property on a new line.',
        },
      },
      create(context) {
        const sourceCode = context.sourceCode;

        return {
          PropertyDefinition(node) {
            const decorator = node.decorators?.at(-1);
            if (
              !decorator ||
              decorator.loc.end.line < node.key.loc.start.line
            ) {
              return;
            }

            const propertyToken = sourceCode.getTokenAfter(decorator);
            if (!propertyToken) return;

            context.report({
              node: decorator,
              messageId: 'newline',
              fix(fixer) {
                return fixer.replaceTextRange(
                  [decorator.range[1], propertyToken.range[0]],
                  `\n${' '.repeat(decorator.loc.start.column)}`,
                );
              },
            });
          },
        };
      },
    },
  },
};

export default defineConfig(
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
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: { '@typescript-eslint/no-deprecated': 'error' },
  },
  {
    files: ['**/*entity.ts', '**/entities.ts'],
    plugins: { localStyle: localStylePlugin },
    rules: { 'localStyle/decorator-property-newline': 'error' },
  },
);
