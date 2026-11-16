import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import globals from 'globals';

const localStylePlugin = {
  rules: {
    'padded-control-flow-blocks': {
      meta: {
        type: 'layout',
        docs: {
          description: 'Require blank lines inside control-flow blocks',
        },
        fixable: 'whitespace',
        schema: [],
        messages: {
          padding:
            'Separate control-flow block braces from their contents with a blank line.',
        },
      },
      create(context) {
        const sourceCode = context.sourceCode;

        function checkPadding(node) {
          if (!(node.body?.length || node.cases?.length)) return;

          const opening =
            node.type === 'SwitchStatement'
              ? sourceCode.getTokenBefore(node.cases[0])
              : sourceCode.getFirstToken(node);
          const closing = sourceCode.getLastToken(node);
          const first = sourceCode.getTokenAfter(opening, {
            includeComments: true,
          });
          const last = sourceCode.getTokenBefore(closing, {
            includeComments: true,
          });
          const indentation =
            sourceCode.lines[opening.loc.start.line - 1].match(/^\s*/)[0];

          for (const [before, after, fallbackIndentation] of [
            [opening, first, `${indentation}  `],
            [last, closing, indentation],
          ]) {
            if (after.loc.start.line - before.loc.end.line >= 2) continue;

            const nextIndentation =
              after.loc.start.line === opening.loc.start.line
                ? fallbackIndentation
                : sourceCode.lines[after.loc.start.line - 1].match(/^\s*/)[0];

            context.report({
              node,
              messageId: 'padding',
              fix(fixer) {
                return fixer.replaceTextRange(
                  [before.range[1], after.range[0]],
                  `\n\n${nextIndentation}`,
                );
              },
            });
          }
        }

        const blocks = [
          'IfStatement > BlockStatement',
          'ForStatement > BlockStatement',
          'ForOfStatement > BlockStatement',
          'ForInStatement > BlockStatement',
          'WhileStatement > BlockStatement',
          'DoWhileStatement > BlockStatement',
          'TryStatement > BlockStatement',
          'CatchClause > BlockStatement',
        ].join(', ');

        return {
          [blocks]: checkPadding,
          SwitchStatement: checkPadding,
        };
      },
    },
    'blank-line-between-methods': {
      meta: {
        type: 'layout',
        docs: {
          description: 'Require a blank line between consecutive class methods',
        },
        fixable: 'whitespace',
        schema: [],
        messages: {
          blankLine: 'Separate consecutive class methods with a blank line.',
        },
      },
      create(context) {
        const sourceCode = context.sourceCode;

        return {
          MethodDefinition(node) {
            const members = node.parent.body;
            const previous = members[members.indexOf(node) - 1];
            if (
              previous?.type !== 'MethodDefinition' ||
              node.loc.start.line - previous.loc.end.line > 1
            ) {
              return;
            }

            const previousToken = sourceCode.getLastToken(previous);
            const currentToken = sourceCode.getFirstToken(node);
            if (!previousToken || !currentToken) return;

            const gap = sourceCode.text.slice(
              previousToken.range[1],
              currentToken.range[0],
            );
            const lineStart =
              sourceCode.text.lastIndexOf('\n', currentToken.range[0] - 1) + 1;
            const indentation = sourceCode.text.slice(
              lineStart,
              currentToken.range[0],
            );

            context.report({
              node,
              messageId: 'blankLine',
              fix(fixer) {
                if (/\S/.test(gap)) return null;
                return fixer.replaceTextRange(
                  [previousToken.range[1], currentToken.range[0]],
                  `\n\n${indentation}`,
                );
              },
            });
          },
        };
      },
    },
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
    files: ['**/*.ts'],
    plugins: { localStyle: localStylePlugin, '@stylistic': stylistic },
    rules: {
      curly: ['error', 'all'],
      'localStyle/padded-control-flow-blocks': 'error',
      'localStyle/blank-line-between-methods': 'error',
      '@stylistic/padding-line-between-statements': [
        'error',
        // Blank line around control flow / multiline statements...
        {
          blankLine: 'always',
          prev: '*',
          next: [
            'block-like',
            'if',
            'for',
            'while',
            'multiline-expression',
            'multiline-const',
            'multiline-let',
            'return',
            'throw',
          ],
        },
        {
          blankLine: 'always',
          prev: [
            'block-like',
            'if',
            'for',
            'while',
            'multiline-expression',
            'multiline-const',
            'multiline-let',
            'const',
            'let',
          ],
          next: '*',
        },
        // ...but keep runs of single-line declarations together.
        {
          blankLine: 'any',
          prev: ['singleline-const', 'singleline-let'],
          next: ['singleline-const', 'singleline-let'],
        },
      ],
    },
  },
  {
    files: ['**/*entity.ts', '**/entities.ts', '**/*dto.ts', '**/dto.ts'],
    rules: {
      'localStyle/decorator-property-newline': 'error',
      'lines-between-class-members': ['error', 'always'],
    },
  },
);
