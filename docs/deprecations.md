# Deprecation review

Reviewed on November 10, 2026 with Node.js 24.22.2 and npm 12.2.2.

## Source and configuration

The TypeScript language service reported nine deprecated API uses. The ESLint
configuration also used a deprecated helper. All ten uses were replaced:

| Location                                                | Deprecated API          | Replacement                              | Uses |
| ------------------------------------------------------- | ----------------------- | ---------------------------------------- | ---- |
| `libs/order/src/messaging/order-events.ts`              | `z.string().uuid()`     | `z.uuid()`                               | 2    |
| `libs/order/src/messaging/order-events.ts`              | `z.string().datetime()` | `z.iso.datetime()`                       | 2    |
| `libs/platform/src/config/environment.ts`               | `z.string().url()`      | `z.url()`                                | 2    |
| `libs/platform/src/config/environment.ts`               | `z.ZodIssueCode.custom` | `'custom'`                               | 1    |
| `libs/platform/src/logging/correlation.middleware.ts`   | `z.string().uuid()`     | `z.uuid()`                               | 1    |
| `libs/demo/src/adapters/postgres-receipt.repository.ts` | `.onConflict(...)`      | `.orIgnore()`                            | 1    |
| `eslint.config.mjs`                                     | `tseslint.config(...)`  | `defineConfig(...)` from `eslint/config` | 1    |

The event schema also uses `z.strictObject(...)` in place of
`z.object(...).strict()`, following the [Zod 4 migration guide](https://zod.dev/v4/changelog).
UUID, timestamp, URL, and unknown-property validation retain their existing
constraints. Zod documents its top-level string format validators in the
[Zod 4 release notes](https://zod.dev/v4).

TypeORM's [insert query builder documentation](https://typeorm.io/docs/query-builder/insert-query-builder/)
describes `orIgnore()`. PostgreSQL generates `ON CONFLICT DO NOTHING`; `event_id`
is currently the receipt table's only unique constraint. Duplicate deliveries
therefore preserve the original receipt and its `receivedAt` value. Review this
choice if another unique constraint is added. Database failures still propagate.

The typescript-eslint package documents its [deprecated config helper and replacement](https://typescript-eslint.io/packages/typescript-eslint/).
ESLint now enables `@typescript-eslint/no-deprecated` with project type
information for application, library, script, and test TypeScript files. This
checks APIs marked deprecated by their installed type definitions on every lint
run; it does not suppress compiler deprecations or inspect package support dates.

ESLint 10's recommended rules also require caught errors to retain their causes.
The worker intentionally throws a sanitized error because KafkaJS logs failures.
A single documented `preserve-caught-error` exception retains that behavior
without attaching potentially sensitive payloads or credentials.

## Dependencies

| Before                                           | Dependency path                                                        | Resolution                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| ESLint 9.39.5, marked unsupported                | Direct development dependency                                          | ESLint 10.14.0 with `@eslint/js` 10.0.1                                                               |
| `glob` 7.2.3, four deprecated lockfile entries   | Jest 29 reporters, configuration, runtime, and coverage transformation | Jest 30.5.2 and compatible ts-jest 29.4.15; these branches now use the existing patched glob override |
| `inflight` 1.0.6, unsupported with a memory leak | `glob` 7                                                               | Removed with the old glob branches                                                                    |

Jest's types were upgraded to version 30 together with the runner.
typescript-eslint's minimum version is now 8.72.2, whose peer range includes
ESLint 10. The migration follows the [ESLint 10 guide](https://eslint.org/docs/latest/use/migrate-to-10.0.0)
and [Jest 30 guide](https://jestjs.io/docs/upgrading-to-jest30).

There are zero `deprecated` entries in the resulting lockfile, and npm's complete
dependency tree is valid without forced peer resolution. The existing scoped
glob/minimatch security overrides remain in place. See [the dependency review](dependencies.md)
for the separate, unresolved low-severity deepmerge advisory.

Jest 30 brings in `@parcel/watcher`. Its optional source-build install hook is
explicitly denied; supported platforms use its published native binaries.
No dependency install scripts were enabled.

## Verification

- Clean npm 12 lockfile installation without deprecation warnings.
- ESLint, including the new deprecated-API rule; strict application/test type checks.
- Prettier and both production builds.
- All 49 unit, HTTP contract, and composition tests under Jest 30, with coverage
  and Node deprecations treated as errors.
- All 5 real-service integration tests, including duplicate receipts and Redis fallback.
- Regenerated OpenAPI matches the committed contract.
- Zero deprecated lockfile entries; valid complete npm dependency tree.
- Production audit: zero findings. Full audit: eight low findings, zero moderate/high/critical findings.

These checks use local services and builds. Previously running application
containers were not rebuilt or redeployed for this review.

Integration still emits the previously recorded KafkaJS `TimeoutNegativeWarning`.
This is not a deprecation warning and was not suppressed.

## Challenge metrics exception

The later complete-challenge implementation explicitly requires `prom-client`.
Version 15.1.3 now carries a registry deprecation notice pointing to
`@prometheus-io/client`. The implementation retains the requested package and
records the exception in [dependencies.md](dependencies.md). Earlier statements
about a deprecation-free lockfile describe the foundation before this addition.
