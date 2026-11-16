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

## Validation refactor request

When I started this project, I asked Codex to create a boilerplate. It did, but
some of its choices need correcting: the generated boilerplate uses
`class-validator`, while I want to use Zod for validation.

Refactor the project to use Zod instead of `class-validator`.

## Idempotent seed and overselling concurrency test request

> Prompts below are recorded verbatim. Names such as `sku` and `available_quantity` were adjusted during implementation to the actual schema (`product_key`, `physical_quantity`).

Create an idempotent database seed and a concurrency test script to validate zero-overselling under simultaneous checkout requests.

Follow the project conventions (`snake_case` database columns, integer cents for prices, TypeORM entities, and PascalCase enums).

### 1. Refactor / Create Idempotent Product & Stock Seed (`src/database/seeds/seed.ts`)

- Ensure the seed can be executed multiple times safely (using `upsert` or checking by `sku`).
- Include standard catalog products AND a specific restricted-inventory product for concurrency testing:
  - `sku`: `'CASE-LIMITED-001'`
  - `name`: `'Limited Edition Titanium MagSafe Case'`
  - `net_price`: `14990` (integer cents)
  - `list_price`: `19990` (integer cents)
  - `is_active`: `true`
- In the `stock` table for `'CASE-LIMITED-001'`, explicitly reset:
  - `available_quantity`: `1`
  - `reserved_quantity`: `0`
- Also clean up any leftover `stock_reservation` rows for this product so repeated test runs start from a clean state.

### 2. Concurrency & Overselling Validation Script (`scripts/test-concurrency.ts`)

Create a standalone TypeScript script (using `axios` or native `fetch`) that simulates a flash-sale race condition:

1. Fetch the product ID for `'CASE-LIMITED-001'` (via `GET /products` or direct DB query).
2. Fire **5 simultaneous `POST /checkout` requests** using `Promise.allSettled()`, each requesting `quantity: 1` of `'CASE-LIMITED-001'`, with distinct customer data and unique `idempotencyKey` / `correlationId` headers.
3. Collect all `orderId`s returned with `202 Accepted` (and log any immediate `409 Conflict` / `422` rejections if stock reservation happens synchronously).
4. **Poll `GET /orders/{orderId}/status`** every 500ms (with a 15-second timeout) until every accepted order transitions out of `Pending` into a terminal state (`Active` or `Cancelled`).
5. **Final Assertions & Summary Report:**
   - Query the database directly (or via endpoints) and print a clear summary table showing:
     - Total requests sent (`5`)
     - Orders with final status `Active` (MUST be strictly `1`)
     - Orders with final status `Cancelled` or rejected at checkout (MUST be `4`)
     - Final `available_quantity` in `stock` table (MUST be `0`, NEVER negative)
     - Final `reserved_quantity` in `stock` table (MUST be `0`)
   - Exit with code `0` if all assertions pass, or exit with code `1` with an explicit error message if overselling or stuck `Pending` orders occurred.

### 3. NPM Scripts (`package.json`)

Add convenient commands to `package.json`:

- `"seed:run"`: executes the seed script.
- `"test:overselling"`: runs the seed first and then executes `scripts/test-concurrency.ts`.

## Contracts library removal request

I did not like how the `libs/contracts` library existed. It was a shared grab-bag
of enums, event schemas, DTO-like types and demo leftovers that no single feature
owned, and it made `order` and `shop` depend on a catch-all package instead of
their own domain.

Delete `libs/contracts`, move its DTOs, enums and similar types into the `order`,
`platform` and `shop` libraries that own them, and remove whatever is not used.

During planning I decided:

- All event-related code (event envelope, event schemas, `ORDER_*` kinds and
  `normalizeOrderEvent`) lives in `libs/order/src/messaging`, not in `platform`.
- The legacy flat-event format stays supported, so the move does not change behavior.

Outcome and review notes:

- The order enums now live in `libs/order`, `CheckoutInput` is inferred from the
  checkout Zod schema, and `ProductView` is local to `libs/shop`. `shop` receives a
  plain items type, so it does not import from `order`.
- Unused code was removed: the demo message schemas and topic, the `CHECKOUT_TOPIC`
  constant (the environment variable remains) and unused event types.
- Typecheck, both builds and Prettier pass. Lint reports the same 18 errors as
  before the change, and the jest suite was not run because `test/` does not exist.

## Consumer event handling

The user asked why Kafka payloads were `unknown` and requested central DLQ handling with the event kind and payload. The agreed approach validates at the consumer boundary, passes the typed event union to the use case, retries transient failures and includes the complete payload only for validated events. Invalid messages retain only safe kind and source metadata.

## Descriptive naming throughout the codebase

Review property, parameter and local variable names throughout the project, not
only constructor dependencies. Use names that clearly express each element's
role, such as `orderRepository`, `configService`, `checkoutGuard`,
`metricsService` and `dataSource`.

Distinguish TypeORM repositories from application repositories when ambiguous:
use names such as `orderTypeOrmRepository` for `Repository<OrderEntity>` and
`orderRepository` for the application's `OrderRepository`.

Apply the same conventions to applications, libraries, migrations, scripts,
seeds, tests, mocks and documentation examples. Update references consistently
while preserving behavior, HTTP and event contracts, database names and exposed
Prometheus metric names.
