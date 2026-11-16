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

const candidates = new Set(
  prettierResult.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => resolve(file)),
);

const eslint = new ESLint({
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
const lintResults = await eslint.lintFiles(['.']);
const lintedFiles = new Set(lintResults.map(({ filePath }) => filePath));

for (const result of lintResults) {
  if (result.output !== undefined) candidates.add(result.filePath);
}

const differences = [];

for (const filePath of candidates) {
  const original = await readFile(filePath, 'utf8');
  const config = await prettier.resolveConfig(filePath);
  let formatted = await prettier.format(original, {
    ...config,
    filepath: filePath,
  });

  if (lintedFiles.has(filePath)) {
    const [result] = await eslint.lintText(formatted, { filePath });
    formatted = result.output ?? formatted;
  }

  if (formatted !== original)
    differences.push(relative(process.cwd(), filePath));
}

if (differences.length) {
  process.stderr.write(
    `${differences.join('\n')}\nFormatting differs. Run npm run format.\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    'All files match the Prettier and ESLint layout format.\n',
  );
}
