import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import * as prettier from 'prettier';

// Check the same Prettier -> ESLint layout pipeline used by npm run format.
const prettierResult = spawnSync(
  process.execPath,
  [
    fileURLToPath(import.meta.resolve('prettier/bin/prettier.cjs')),
    '--list-different',
    '.',
  ],
  { encoding: 'utf8' },
);

if (prettierResult.error) throw prettierResult.error;

if (prettierResult.stderr) process.stderr.write(prettierResult.stderr);

if (prettierResult.status !== 0 && prettierResult.status !== 1) {
  process.exit(prettierResult.status ?? 1);
}

const candidatePaths = new Set(
  prettierResult.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => resolve(file)),
);

const eslintFormatter = new ESLint({
  fix: true,
  fixTypes: ['layout'],
  overrideConfig: {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: false, project: null },
    },
    rules: { '@typescript-eslint/no-deprecated': 'off' },
  },
});
const lintResults = await eslintFormatter.lintFiles(['.']);
const lintedPaths = new Set(lintResults.map(({ filePath }) => filePath));

for (const lintResult of lintResults) {
  if (lintResult.output !== undefined) candidatePaths.add(lintResult.filePath);
}

const formattingDifferences = [];

for (const filePath of candidatePaths) {
  const originalSource = await readFile(filePath, 'utf8');
  const prettierConfig = await prettier.resolveConfig(filePath);
  let formattedSource = await prettier.format(originalSource, {
    ...prettierConfig,
    filepath: filePath,
  });

  if (lintedPaths.has(filePath)) {
    const [lintResult] = await eslintFormatter.lintText(formattedSource, {
      filePath,
    });
    formattedSource = lintResult.output ?? formattedSource;
  }

  if (formattedSource !== originalSource)
    formattingDifferences.push(relative(process.cwd(), filePath));
}

if (formattingDifferences.length) {
  process.stderr.write(
    `${formattingDifferences.join('\n')}\nFormatting differs. Run npm run format.\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    'All files match the Prettier and ESLint layout format.\n',
  );
}
