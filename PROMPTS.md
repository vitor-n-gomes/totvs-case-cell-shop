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
