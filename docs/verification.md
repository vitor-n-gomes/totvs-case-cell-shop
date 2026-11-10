# Foundation verification

Recorded on November 10, 2026, using Node.js 24.22.2, npm 12.2.2, and Docker Engine 28.5.1.

| Check                                                  | Result                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| Unit, HTTP contract, and application composition tests | Passed: 49 tests in 7 suites                                              |
| Strict TypeScript check                                | Passed                                                                    |
| ESLint                                                 | Passed                                                                    |
| Prettier check                                         | Passed                                                                    |
| API and worker production builds                       | Passed                                                                    |
| OpenAPI generation without infrastructure              | Passed                                                                    |
| Compiled entry points reject missing configuration     | Passed for both apps                                                      |
| Migration data source loads without connecting         | Passed; synchronization and startup migrations disabled                   |
| Compose configuration validation                       | Passed                                                                    |
| Migrations against PostgreSQL                          | Passed in both the dedicated test database and application database       |
| Real Kafka/PostgreSQL/Redis integration tests          | Passed: 5 tests in 1 suite                                                |
| Integration receipt cleanup                            | Passed; test receipt table empty after the suite                          |
| API, worker, and migration container builds            | Passed using clean lockfile installs                                      |
| Container startup and readiness                        | Passed; both app containers and all three support services healthy        |
| Migration and topic initialization jobs                | Passed; both exited with code 0                                           |
| Publish/receipt flow across separate containers        | Passed: HTTP 202 followed by HTTP 200 with the original correlation ID    |
| Swagger UI and runtime OpenAPI                         | Passed                                                                    |
| Production dependency audit                            | Passed; zero findings                                                     |
| Full dependency audit                                  | Eight low development-tool findings from one unpatched deepmerge advisory |
| npm 12 install-script review                           | Passed; no unreviewed scripts and optional hooks explicitly denied        |
| TypeScript 5.9.3 and 6.0.3 compatibility               | Passed for both application and test projects; no deprecation suppression |
| GitHub Actions workflow                                | Configured; no remote run performed                                       |

The security update was verified with a clean npm 12 install, all 54 tests, and
fresh container builds. NestJS stays on version 11 and the public OpenAPI contract
is unchanged. See the [dependency review](dependencies.md) for the remaining
upstream advisory and the exact install-script policy.

The subsequent [deprecation review](deprecations.md) upgraded Jest to 30 and
ESLint to 10, replaced deprecated source APIs, and added lint enforcement. It
records the checks repeated for those changes; the container results below
describe the earlier foundation and security verification.

The live integration suite verified HTTP publication, consumer persistence,
repeated delivery producing one immutable receipt, Redis cache hits and TTL,
uncached misses, and database fallback after the API's Redis connection was
closed. Both Nest application contexts closed without forced termination.

The container smoke check then exercised the built API and worker as separate
processes, using the storefront database and the explicitly initialized demo
Kafka topic. The receipt preserved the original message, event ID, and
correlation ID. Swagger UI and its generated JSON were also reachable.

The integration run emitted a Node.js `TimeoutNegativeWarning` during Kafka
initialization. All tests and runtime checks passed; the warning was not
suppressed and no installed dependency code was patched.

## Repeat the live checks

Requires a working Docker Linux engine and WSL integration when using Docker
Desktop from WSL.

```bash
npm run infra:up
cp .env.test.example .env.test.local
npm run test:integration
docker compose up -d --build --wait api worker
curl --fail http://localhost:3000/health/ready
curl --fail http://localhost:3001/health/ready
```

The apps were left running for local review. Swagger is available at
[localhost:3000/api-docs](http://localhost:3000/api-docs). Use
`npm run infra:down` to stop this project's containers while retaining their
volumes.

The [README](../README.md) describes setup, isolation, cleanup, and the demo's
guarantees and limitations. The [CI workflow](../.github/workflows/ci.yml) runs the
same checks after the repository is pushed. Checkout and inventory behavior
remain outside this foundation's scope.
