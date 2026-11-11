# AI assistance record

## User direction

The original request identified `src` as an unrelated boilerplate and asked to apply skills to improve readability and demonstrate senior engineering judgment, with at least two applications: HTTP and Kafka consumption.

During planning, the user selected:

- Architecture foundation rather than the complete challenge.
- Kafka, PostgreSQL, and Redis as local support services.
- Feature-first organization with clear boundaries.
- A small end-to-end demonstration rather than bootstrap-only scaffolding.

The user then explicitly requested implementation of the agreed “CaseCellShop: two-app NestJS foundation” plan.

## Relevant instructions used

- Apply the repository's [NestJS best-practices skill](.agents/skills/nestjs-best-practices/SKILL.md) to feature modules, explicit exports, constructor injection, repository boundaries, validation, configuration, and lifecycle management.
- Keep HTTP controllers and consumers thin; use focused use cases rather than generic base classes.
- Return publication success only after broker acknowledgement; propagate persistence errors so failed processing is not silently committed.
- Prove the infrastructure with isolated integration tests without implementing checkout prematurely.

## Review decisions

- Two runnable applications share a storefront-owned database and reusable feature code. This is a monorepo foundation, not a claim of independent microservice ownership.
- The consumer uses KafkaJS inside Nest lifecycle hooks for explicit subscription and processing behavior.
- Database uniqueness protects the receipt effect against duplicate delivery. It does not provide HTTP checkout idempotency or exactly-once transport.
- Redis caches only immutable positive receipts and stays optional for reads.
- Local configuration supports `.env`, optional `.env.local` overrides, and an explicit `ENV_FILE`. Legacy database variable names are not mapped to the storefront database. Integration tests require dedicated local test resources and ignore application environment files.
- The demo does not implement orders, stock consistency, transactional outbox, DLQ, ERP reconciliation, metrics, or distributed tracing. Those guarantees require separate work and tests.

## Verification discipline

Run lint, formatting, strict type checks, unit tests, and both application builds. Generate OpenAPI from the actual controller and DTO metadata without infrastructure connections. Run real-service tests and container smoke checks when Docker is available; document unavailable checks rather than treating them as successful.

The assistant's changes and generated contracts require human review before submission. A public repository has not been created or published by this implementation.

## Complete challenge implementation

The next request was: `docs/tasks.md, casecellshop_senior_backend_challenge.md — do it`.
After inspecting the existing foundation, the user approved a complete implementation plan covering all thirteen tasks and the five conceptual answers. The user selected:

- Keep the task-defined activation order: stock consumption and ACTIVE precede ERP/email.
- Use camelCase HTTP fields, snake_case database/event fields and English code/documentation.
- Deliver in the existing local branch without committing or pushing.

The explicit execution request was `PLEASE IMPLEMENT THIS PLAN`, followed by the full agreed plan. Work paused when requested and resumed after `continua ai`.

### Implementation and critical review

The implementation applies the repository NestJS skill to feature modules, constructor injection, validation, explicit migrations and thin transport handlers. It adds PostgreSQL-backed idempotency, stock constraints, atomic reservations, outbox leases, an explicit retry/DLQ workflow and a Redis mutex with ownership checks.

The original task prompts needed these corrections/clarifications:

- Kafka does not create application retries or a DLQ merely because a handler logs an error. Retry/DLQ intent is persisted explicitly before allowing offset advancement.
- Consuming stock and marking ACTIVE independently permits partial state. They and their success logs commit in one transaction while retaining the requested step order.
- HTTP retries need a persisted unique request key and canonical hash; successful activation logs alone do not prevent duplicate orders.
- Remote success followed by a crash cannot be made exactly-once by a local success log. Stable simulated provider keys and the production limitation are documented.
- ACTIVE is distinct from fully processed. A separate processing status makes ERP/email failures visible.
- Cache freshness does not authorize a stock sale. Checkout reads prices and reserves inventory in PostgreSQL.
- Expiration and activation use the same locking order; cleanup cannot restock consumed units.
- The TypeORM PostgreSQL driver's raw UPDATE result is a tuple of rows and affected count. Real integration testing exposed and corrected the initial raw-result handling in stock and outbox repositories.
- The installed Nest scheduling library is ESM. Jest uses Node 24.9+ VM module support; the application remains CommonJS and builds for Node 24.

The implementation includes real-service tests for overselling, duplicate keys/events, multi-item rollback, expiration races, persisted retries, terminal failures, DLQ outages, publication leases and shared-cache coalescing. Conceptual answers and runbooks distinguish implemented guarantees, local simulations and production work.

No public repository was created or updated by this task. Existing historical foundation notes above describe the earlier phase; current behavior and verification are recorded in README and docs/verification.md.

### Final validation and handoff

The user reported missing-member diagnostics such as
`Property 'ensureConnected' does not exist on type 'KafkaConnection'` and asked
the assistant to finish before their own review. The method exists in the current
source; root, test and all application/library compiler checks passed. No editor
state was available, so an IDE diagnosis was not presented as confirmed.
Connection lifecycle tests were added against the actual class.

Final verification passed 77 unit tests and 23 integration tests, including cold
API startup with refused Kafka/Redis connections. Compose API startup was
uncoupled from Kafka/Redis health. Containers built and completed a purchase smoke
test on ports 3300/3301, preserving the process already using port 3000. The seed,
migrations, generated contract and validation results are recorded in
`docs/verification.md`. All work remains local with no commit or push.
