# Dependency review

Reviewed on November 10, 2026 with Node.js 24.22.2 and npm 12.2.2.

| Audit                   | Before           | After      |
| ----------------------- | ---------------- | ---------- |
| Critical                | 1                | 0          |
| High                    | 17               | 0          |
| Moderate                | 20               | 0          |
| Low                     | 10               | 8          |
| Production dependencies | Findings present | 0 findings |

## Changes

- Update NestJS within version 11, including its HTTP adapter, configuration,
  Swagger, testing integration, and CLI. Retain the existing application layout.
- Update TypeORM within version 0.3, PostgreSQL's client, class-validator, and
  compatible transitive dependencies.
- Upgrade Zod to the patched version 4 release. Validate existing request/event
  contracts and environment configuration through the automated suites.
- Override vulnerable `glob` versions 9–13 to patched version 14 and vulnerable
  `minimatch` versions 7–11.0.0 to patched version 11. These overrides are scoped
  so older dependency branches with different APIs remain untouched. Reassess
  them when upstream packages adopt the patched versions.
- Upgrade Jest and its typings together to version 30 during the subsequent
  [deprecation review](deprecations.md), removing deprecated glob 7 and inflight
  dependencies. Upgrade ESLint to version 10 and use its `defineConfig` helper.

The manifest and lockfile contain the remediation. No audit finding is hidden
through `audit=false`, an advisory exclusion, or a blanket forced upgrade.

## Remaining development advisory

`deepmerge` 4.3.1 has no published patched release for
[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4).
It is used by Jest's configuration loader and the Nest CLI's webpack type checker,
and is absent from the production dependency tree. npm propagates this single
advisory through eight development packages.

The proposed `npm audit fix --force` downgrades Jest to version 25 and the Nest CLI
to version 7. Those versions do not match this project. Do not apply those
downgrades to silence the report. Track the
[upstream issue](https://github.com/TehShrike/deepmerge/issues/273) for a supported
fix. Treat project build/test configuration as trusted code.

CI requires a clean production audit and rejects moderate-or-higher findings
across the full tree. A plain `npm audit` still reports the eight low findings and
returns a nonzero exit code. `npm audit --omit=dev` passes with zero findings.

## Install scripts

Use npm 12.2.2 locally; CI and Docker images use that version too. The
`allowScripts` entries in `package.json` explicitly deny these optional hooks:

- `@nestjs/core`: the donation notification hook.
- `@scarf/scarf`: the package telemetry reporter.
- `@parcel/watcher`: the optional source-build hook; published platform binaries
  support the Jest watcher without running it.

No dependency script is approved globally. npm can still report a newly added
dependency's unreviewed script so it receives an explicit decision.
[npm's install-script documentation](https://docs.npmjs.com/cli/commands/npm-install-scripts/)
describes the policy and the read-only review command:

```bash
npm install-scripts ls
npm audit --omit=dev
npm audit
```
