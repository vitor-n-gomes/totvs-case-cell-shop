# Complete challenge verification

Updated on November 11, 2026. Verification used Node.js 24.22.2 and Docker Engine 28.5.1. Local verification scripts ran with npm 11.19.1; clean container builds, migrations and seed used the pinned npm 12.2.2. This supersedes the earlier foundation-only verification record.

## Orders refactor status

The verification record below describes the version before the Orders refactor. Its passing test and container results do not verify the refactored applications. Production TypeScript, the `http` / `consumer` builds, changed-file lint/formatting and OpenAPI generation passed on Node 24.22.2. An offline TypeORM metadata inspection found nine distinct tables, no duplicate order columns and resolved query bindings; no database connection was opened. Unit and integration suites are intentionally unchanged and were not run; their imports still point at the previous structure. Infrastructure behavior is awaiting the user's manual validation using [manual-validation.md](manual-validation.md).

## Earlier automated verification

| Check                                                   | Result                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| Unit tests, HTTP validation and module composition      | Passed: 77 tests in 11 suites; includes the original 49 tests |
| Real PostgreSQL/Redis/Kafka integration                 | Passed: 23 tests in 3 suites                                  |
| TypeScript root, test, application and library projects | Passed                                                        |
| ESLint                                                  | Passed                                                        |
| Prettier                                                | Passed                                                        |
| API and worker production builds                        | Passed                                                        |
| OpenAPI export and deterministic regeneration           | Passed                                                        |
| Production dependency audit                             | Passed: zero vulnerabilities                                  |
| Container builds, migrations, seed and purchase smoke   | Passed on host ports 3300/3301                                |
| GitHub Actions                                          | Updated; no remote run or push performed                      |

The real-service tests prove atomic checkout under 20 concurrent buyers for five units, simultaneous idempotency replays, conflicting request content, full-cart rollback, duplicate worker delivery, expiration versus activation, rollback of consumption when activation fails, persisted retries, terminal ERP/email failures, outbox lease recovery and DLQ failure handling. They also verify Redis coordination across two service instances, cache TTL, abandoned lock recovery, Redis fallback, API readiness independent of Kafka, sanitized request audit records and metrics endpoints. A fresh API instance also starts, reads the catalog and accepts checkout while both Kafka and Redis endpoints refuse connections.

Migrations were applied, reversed and reapplied in a unique PostgreSQL schema. The migration test drops only its own schema. Other integration tests use the dedicated local `_test` database, Redis `/1` and unique Kafka topics/groups, and remove their own fixtures on completion.

The original demo HTTP/Kafka/cache tests remain passing. Its integration setup now creates isolated checkout/DLQ topics too, since both consumers belong to the worker, and removes its own request audit records.

## Review findings corrected

- TypeORM raw PostgreSQL UPDATE results contain `[rows, affectedCount]`. Integration testing exposed incorrect initial assumptions in stock and outbox reads; affected-row and claim handling were corrected.
- Consumption, activation and both idempotency success records commit atomically. A fault-injection test proves rollback when the second step fails.
- Audit draining runs before dependency shutdown and reschedules if work arrives at the drain boundary.
- The API's Kafka connection is optional for startup/readiness and checkout does not call the producer. Compose now waits only for the database migration job before starting the API; Kafka topic initialization remains a worker dependency.
- Successful step logs, retry state and DLQ intent persist across handler invocations. Terminal orders are not blindly reset or automatically replayed.
- The ESM scheduler requires Jest's VM-module support on Node 24.9+. The shell initially selected Node 20; verification explicitly used the installed Node 24 binary.

## Final container validation and reported diagnostic

The earlier container attempt stopped on Kafka's five-second healthcheck timeout.
The probe now allows twenty seconds. The final build and startup passed. Port 3000
was already occupied, so the verification used configurable host ports 3300 and
3301 and did not stop the existing local process.

The final seed succeeded without resetting existing stock. The smoke script
verified API/worker readiness, catalog reads, a 202 checkout, replay of the same
idempotency key, Active/Completed order state and both metrics endpoints. The
verified order ID is `c3d9d1f3-bd89-4211-a4a3-f5ccac1c5fdd`.

The reported `KafkaConnection.ensureConnected` missing-member diagnostic could
not be reproduced against the current workspace. The method is defined in
`libs/platform/src/messaging/kafka-connection.ts`. Both root/test compilation and
all five existing application/library TypeScript configurations passed. Four
additional tests exercise the actual connection class: concurrent initialization,
recovery after failure, nonblocking startup and shutdown/topic checks. Editor
buffer or language-service state was not verified during that initial check.

## Editor import resolution follow-up

The `Cannot find module '@app/shop/orders/checkout'` diagnostic was reproduced
with the workspace TypeScript 5.9.3 language server by opening `apps/api` as the
project root. The editor only discovers standard `tsconfig.json` filenames and
stops its search at that root. The existing `tsconfig.app.json` was therefore
missed, creating an inferred project without aliases or Nest decorator settings.
The same issue affected the worker and libraries opened as separate folders.

Each app/library now has a standard `tsconfig.json` extending its existing Nest
configuration. The shop library also has its missing library configuration,
module entry point and Nest project registration. Scripts have a local editor
configuration; tests retain their existing one. Aliases remain defined once in
the root configuration.

After the change, the language server selected the expected configuration and
returned zero semantic diagnostics for a representative file in each of the
eight projects, including the shop controller, checkout consumer and Kafka
publisher. An exhaustive import-resolution check resolved all 174 `@app/*`
imports across 92 TypeScript files using each file's nearest editor configuration.
Root/test typechecks, ESLint, Prettier and both production builds also passed on
Node 24. All 77 unit tests passed after allowing the HTTP tests to bind loopback
sockets; the initial sandboxed run rejected those sockets with `EPERM`.
These checks exercise a fresh language server; an already-open editor may need
**TypeScript: Restart TS Server** to discard its previous inferred projects.

## Practical limits

Failures of broker publication, DLQ delivery and integrations are injected at their adapters while the persistence tests use real PostgreSQL, Redis and Kafka. These are deterministic recovery tests, not a production chaos test that physically kills a broker or host. The added cold-start test uses actual refused local connections for Kafka and Redis, while keeping PostgreSQL available. Restart recovery is exercised through new invocations reading persisted state; no claim of exactly-once remote effects is made.

The cache test creates two independent use-case instances against the same Redis/database. The container smoke test additionally exercises independently running API/worker processes. No multi-host performance benchmark or SLO validation was performed.

ERP and email remain simulations. Trace spans are structured log stubs, without an external tracing backend. Automatic reconciliation handles expired local reservations; ERP invoices require the documented operator procedure and a real integration before automated reconciliation can be implemented.

Node emits an experimental VM-modules warning during Jest runs; KafkaJS can emit a `TimeoutNegativeWarning` during initialization. These warnings were not suppressed or patched in installed packages. The requested `prom-client` dependency has a documented registry deprecation exception; see [dependencies.md](dependencies.md).

## Reproduce

```bash
nvm use
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
npm run infra:up
cp .env.test.example .env.test.local
npm run test:integration
docker compose up -d --build --wait http consumer
docker compose run --rm migrate npm run seed
npm run test:smoke
```

Do not point the integration suite at application data or share Redis `/1` with development workloads. Docker smoke tests use the local application database and consume one unit from the explicitly seeded catalog.
