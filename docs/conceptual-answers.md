# Part 1.A - Conceptual answers

These answers use the challenge scenario for the diagnosis and the current repository as the practical example. The local solution has three applications: an HTTP API, a Kafka consumer with an outbox relay, and a reservation-expiration scheduler. They use a storefront-owned PostgreSQL database; the solution also uses Redis and Kafka. ERP invoicing and email are simulations, not real integrations. The [README](../README.md) explains how to run them.

## Question 1: Diagnosis, trade-offs and target architecture

### 1. Storefront performance

**Root cause:** every storefront page depends on a synchronous ERP read. As traffic grows, identical catalog requests compete with the ERP's inventory and invoicing workload. Scaling only the storefront can make ERP contention worse.

**Impact:** customers see slow pages or errors; conversion and revenue fall; operations face timeouts and a slower ERP.

| Strategy                         | Cost and complexity                                                  | Latency and consistency                                                    | Operational effort                                         |
| -------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Cache ERP responses              | Low initial cost; little application restructuring                   | Fast hits, but misses still depend on the ERP and cached data can be stale | Manage TTL, invalidation, stampedes and ERP load on misses |
| Storefront read model plus cache | Moderate cost for a separate database and synchronization            | Fast local reads; data is eventually consistent with the ERP               | Monitor sync lag, failures, replay and reconciliation      |
| Larger ERP or read replica       | Infrastructure and ERP coordination costs; fewer application changes | More read capacity, but coupling remains and a replica can lag             | Capacity planning, replica monitoring and recovery         |

**Choice:** a storefront-owned read model plus Redis. An approved read-only ERP API, export or replica populates the read model without changing ERP tables, routines or internal code. An explicit freshness policy is still required: a cache or replica cannot make delayed source data current.

### 2. Stock overselling

**Likely root cause:** checking availability and later updating stock are separate operations. Two buyers can both observe the last unit. Stale cache entries and other sales channels worsen the problem when they operate on the same physical stock without a shared authority. The challenge does not provide the existing checkout implementation, so this diagnosis needs verification.

**Impact:** customers receive cancellations or refunds after ordering; the business loses trust and incurs support and reconciliation costs.

| Strategy                                                  | Cost and complexity                                                                              | Latency and consistency                                                                           | Operational effort                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Reserve in an authoritative ERP API                       | Low local inventory ownership, but depends on an ERP operation that supports atomic reservations | Strong across channels if every channel uses it; checkout depends on ERP latency and availability | Coordinate with the ERP team; monitor its capacity and failures |
| Atomic updates against an exclusive storefront allocation | Moderate; the allocation and its ownership must be agreed                                        | Strong within the allocation and fast locally; does not cover unallocated stock                   | Reconcile allocations, reservations and adjustments             |
| Distributed lock around a read and write                  | Extra infrastructure and lease/failure handling                                                  | A lock alone cannot guarantee an atomic stock update or coordinate channels that ignore it        | Maintain lock ownership and fencing; investigate lease loss     |

**Choice:** use database-backed reservations against an exclusive allocation, or an authoritative ERP reservation operation if one exists. Polling a shared ERP stock balance cannot strictly prevent cross-channel overselling. If neither an exclusive allocation nor a shared atomic authority is available, the global guarantee is not achievable.

### 3. Checkout and slow invoicing

**Likely root cause:** checkout waits for a slow external side effect. A timeout does not reveal whether the ERP already created the invoice, so an uncoordinated retry can duplicate it. The current ERP timeout and retry behavior needs investigation.

**Impact:** customers abandon checkout or receive delayed confirmations; the business risks duplicate invoices; operations must investigate ambiguous and stuck orders.

| Strategy                              | Cost and complexity                      | Latency and consistency                                                                  | Operational effort                                 |
| ------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Longer synchronous timeout            | Low implementation cost                  | Customer latency and connection usage grow; timeout outcomes remain ambiguous            | Handle retry storms and blocked requests           |
| Save the order and publish separately | Moderate implementation cost             | Faster response, but a crash between writes can lose an event or produce a ghost message | Detect and repair dual-write failures              |
| Transactional outbox and worker       | Moderate implementation and storage cost | Fast durable acceptance followed by eventual processing; duplicates remain possible      | Operate the relay, retries, DLQ and reconciliation |

**Choice:** commit the order and an outbox event together, then process asynchronously. `202 Accepted` means the request was durably accepted, not that invoicing or delivery succeeded. The customer needs an order-status endpoint and a way to learn about delays or failures.

### Target architecture for the next 30–90 days

```text
ERP read API/export/approved replica
        │
        ▼
  Sync worker ──> storefront PostgreSQL catalog ──> Redis ──> GET /products
                         │
POST /checkout ──> PostgreSQL transaction:
                   order + price snapshots + reservations + outbox
                                │ commit
                                ├──> 202 Pending
                                └──> outbox relay ──> Kafka
                                                        │
                                              activation worker ──> ERP / email
                                                        │
                                                retry outbox / DLQ

Expiry scheduler ──> Kafka ──> consumer releases eligible reservations
Reconciliation ──> compare ERP invoices and allocated stock with local records
Observability ──> logs, metrics, traces, dashboards and alerts across the flow
```

In the **proposed** ERP integration, the sync worker imports products and prices through an approved read-only interface, stores a source version or watermark where available, and invalidates affected cache entries after committing. It must handle duplicate and out-of-order changes. If no reliable change cursor exists, use periodic snapshots with deletion detection and reconciliation. Monitor the last successful sync and the age of source data.

Stock synchronization must not overwrite live reservations. Agree on exclusive allocations or a shared reservation authority, compare allocations and reservation balances, and stop affected sales or escalate when the agreement cannot be honored. Reconcile invoices by stable order/provider ID; investigate ambiguous outcomes before retrying or compensating. Never silently overwrite discrepancies.

- **Days 1–30:** establish latency, error and freshness baselines; agree on stock ownership and price freshness; pilot the current local cache, atomic checkout and idempotency design against representative traffic.
- **Days 31–60:** integrate an approved read-only catalog sync; deploy the outbox, workers, status flow, bounded retries and DLQ; add dashboards and tested runbooks.
- **Days 61–90:** automate stock and invoice reconciliation, exercise dependency failures and recovery, validate SLOs and capacity, and add appropriate HA and disaster-recovery procedures.

The repository demonstrates the local database, cache, outbox, consumer and scheduler. Live ERP synchronization, automated ERP reconciliation, multi-channel inventory ownership, HA and disaster recovery are future work.

## Question 2: Cache, invalidation and storefront performance

### Layers and current behavior

- **CDN, proposed:** serve static images and assets near customers. Cache public catalog responses only if keys include every price-affecting dimension, such as currency, region and customer tier; never share personalized prices under a common key.
- **Redis, implemented:** cache the catalog returned by `GET /products` under `storefront:products` for 300 seconds. A miss loads the catalog from PostgreSQL. The response includes product details and prices, not an authoritative stock promise. See [GetProductsUseCase](../libs/products/src/adapters/usecases/get-products.use-case.ts).
- **PostgreSQL, implemented:** own the local catalog, orders and allocated stock. Checkout reads local prices and reserves stock in a database transaction; it never uses Redis to authorize a purchase.
- **Per-process cache, proposed:** consider a very short cache only if measurement justifies the extra invalidation complexity. The existing per-process single-flight coalesces concurrent loads; it is not a separate persistent cache.

### Freshness, invalidation and failure handling

1. **TTL and invalidation:** the local seed invalidates the catalog cache and lock after committing; the consumer also invalidates the catalog after reservation expiry. The 300-second TTL limits the lifetime of a cache entry, not the age of ERP data. There is currently no live ERP sync or product-update API. For production, select separate freshness budgets for descriptions, prices and availability, invalidate after committed updates, and keep TTL as a safety net. Durable invalidation and version-checked cache writes are needed to handle failed invalidation and an older in-flight refresh.
2. **Cache-aside versus refresh-ahead:** cache-aside is simple and fits the current catalog. Refresh-ahead can reduce miss latency for popular entries but needs scheduling, capacity and ownership controls. Apply jitter when many independent keys might expire together; refresh-ahead is not currently implemented.
3. **Stampede protection:** the implementation combines per-process single-flight with a Redis lock. The lock has a five-second lease; publication and release check the owner's token. Other callers wait for a populated entry and return `503` after the refresh deadline rather than all loading the database. If Redis is unavailable, the API falls back to PostgreSQL with local coalescing; separate replicas can still load PostgreSQL concurrently. Production should add bounded database concurrency and load shedding for sustained outages.
4. **Prices and stock:** a TTL cannot guarantee that a displayed price or stock level is current at every instant. The demo snapshots the local price but does not bind it to a customer-approved quote or charge a payment. For production, compare an accepted quote/version with an authoritative price, reconfirm changes before charging, and reject or defer checkout when the source freshness guarantee cannot be met. If the business requires every displayed change to be immediately current, an asynchronously polled cache alone is insufficient; an authoritative read or a source-backed price/availability guarantee is required.

### Measuring success

Compare the same representative workload before and after caching:

- Cache hits divided by hits plus misses, invalid entries, Redis-unavailable fallbacks, refresh lock waits/timeouts and database loads per expiry burst.
- `GET /products` p50/p95/p99 latency, error rate, PostgreSQL and ERP reads per 1,000 requests, and infrastructure resource cost.
- Cache-entry age **and** source/sync age; price-version mismatches, freshness-budget breaches, reservation rejections and reconciliation discrepancies.

Initial targets could be an 80% hit ratio and 50% fewer database reads, without exceeding agreed freshness limits. These are proposals, not measured results; better hit ratio or latency is not success if customers receive incorrect prices or stock promises.

## Question 3: Observability

### Structured logs

For production, require timestamp, level, service, deployment/environment and event name. Include `correlation_id` and trace/span IDs when a request or trace exists; add `order_id`, `event_id`, attempt, step and outcome where applicable. HTTP records need route template, method, status and duration. Kafka records need topic, partition, offset and a classified failure reason.

Use identifiers to investigate an order, but do not put contacts, credentials or arbitrary payloads in logs. The current [Pino logger](../libs/platform/src/logging/app-logger.ts) carries application and available correlation/trace context; not every proposed field is present on every existing log.

### Metrics

| Type       | What to measure                                                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Counters   | Cache hit/miss/invalid/unavailable; checkout accepted/replayed/rejected; reservation transitions; retries; DLQ scheduling/publication; ERP success, timeout and failure |
| Gauges     | Pending and oldest due outbox event; Kafka consumer lag; active reservations; sync age; unresolved stock and invoice discrepancies                                      |
| Histograms | HTTP and checkout transaction duration; cache load and lock wait; ERP call duration; time from acceptance to completed processing                                       |

The HTTP and consumer applications expose [metrics](../libs/platform/src/observability/metrics.ts) at `/metrics`: `shop_cache_requests_total`, `shop_checkout_total`, `shop_reservations_total`, `shop_processing_total`, `shop_request_log_total`, HTTP and step duration histograms, and outbox count/age gauges. The scheduler has no HTTP endpoint. Broker lag, reconciliation discrepancies, lock-wait and end-to-end completion metrics need additional instrumentation or external monitoring. The existing outbox age includes pending scheduled events, so an alert specifically for **due** events needs a separate measure. Use low-cardinality labels such as route, result, integration and failure class; keep order and product IDs in logs/traces rather than metric labels.

### Traces

- **`GET /products`:** HTTP request → Redis lookup and lock wait → PostgreSQL read on a miss → cache publication.
- **`POST /checkout`:** HTTP request → validation and idempotency → database transaction for order, reservations, items and outbox.
- **Async continuation:** outbox publication → Kafka consumer → reservation consumption and order activation → ERP → email. Link retries to the original event and include order and attempt identifiers. Expiration can use a separate trace linked by order ID.

The repository emits `trace.span` logs and carries trace/correlation identifiers in event metadata, but it is a local tracing stub, not an OpenTelemetry or Datadog exporter. For production, instrument missing spans, propagate W3C trace context, use appropriate span links for asynchronous work and retries, and export through a collector.

### SLIs, SLOs, alerts and runbooks

The following are **initial targets**, not benchmark results:

- **Availability:** at least 99.9% of eligible HTTP requests succeed over 30 days; measure expected business rejections separately.
- **Latency:** successful catalog p95 below 200 ms and accepted checkout p95 below 300 ms at the API boundary.
- **Completion:** at least 99% of accepted orders reach completed processing within 60 seconds over 30 days, including dependency incidents. Count failed, expired or still-unfinished orders against this objective after the deadline; a healthy-dependency view is diagnostic only.
- **Correctness:** overselling and duplicate invoices are zero-tolerance invariants. Measure price freshness breaches and reconciliation discrepancies separately.

Dashboards should show catalog latency and cache outcomes, the accepted-to-completed order funnel, retries/DLQ, outbox age, consumer lag, ERP latency, sync freshness and inventory discrepancies. Example alerts: HTTP 5xx above 1% for five minutes with sufficient traffic; oldest **due** outbox event above 60 seconds for five minutes; any DLQ arrival or stock invariant mismatch; and sync age beyond its agreed budget. Use multi-window error-budget burn alerts and assign an owner and escalation path.

Runbooks should tell operators to check cache health and database load before shedding traffic; trace pending orders through the outbox and consumer; fix the cause before any DLQ replay; and compare reservations and ERP invoice state before a manual correction. In particular, do not blindly replay a terminal order or restock a consumed order. More operational examples are in the [README runbooks](../README.md#runbooks).

## Question 4: Concurrency, inventory and idempotency

### Preventing overselling

With one unit left, requests A and B can both read `1` before either writes. A later update is too late to make the earlier decision safe. The availability check and reservation must be atomic, or protected by a database lock that all writers respect.

| Mechanism                 | Benefit                                                                | Trade-off                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Conditional atomic update | A single database statement admits only an available quantity          | Hot product rows serialize; the affected-row count must be checked                                           |
| Pessimistic row lock      | Protects multi-step decisions and transitions in one transaction       | Lock waits and deadlocks require short transactions and consistent lock ordering                             |
| Reservation               | Holds stock while asynchronous processing runs and supports expiration | Requires atomic reserve, consume and release, plus expiry and reconciliation                                 |
| Distributed lock          | Can coordinate cache refresh or other work across processes            | Lease expiry or a worker pause can invalidate ownership; it does not replace database constraints or fencing |

The [stock repository](../libs/products/src/inventory/repositories/stock.repository.ts) reserves with `physical_quantity - reserved_quantity >= quantity` in the update itself and checks the affected rows. Products are processed in stable ID order. PostgreSQL constraints enforce nonnegative quantities and `reserved_quantity <= physical_quantity`; a failed item rolls back the entire checkout.

Reservations expire after 900 seconds by default. The separate scheduler publishes expiration events for eligible pending orders; the consumer verifies expiry and releases active reservations transactionally. Activation and expiration use the same order-scoped advisory lock, while database row locks and constraints protect inventory. Stock consumption and order activation commit together; `Active` does not mean the simulated ERP and email steps have completed. See [ReservationRepository](../libs/products/src/inventory/repositories/reservation.repository.ts) and the [activation strategy](../libs/orders/src/activation/strategies/online-activation.strategy.ts).

This prevents overselling only within the storefront's allocated stock. Other channels need the same authority or non-overlapping allocations.

### Idempotency and tests

The [checkout use case](../libs/orders/src/adapters/usecases/checkout.use-case.ts) persists a unique `Idempotency-Key` and a canonical request hash. A retry or double-click must reuse the **same key**: equivalent content returns the original `202`, `orderId` and `Pending` response, even if the order has since progressed; changed content, including `X-Environment`, returns `409`. Clients use the status endpoint for the current state. Order, price snapshots, reservations and outbox event commit together, so a failed transaction does not leave a partial purchase. Keys are global in this unauthenticated demo; production should scope them to the authenticated customer and define retention.

Worker idempotency is separate. Successful steps are recorded uniquely per order/action/step, and local stock effects and their success records commit together. For a real ERP or email provider, use a stable provider idempotency key or a lookup/reconciliation API: a crash after a remote success but before the local success record can otherwise repeat the remote effect.

Test with real PostgreSQL, not mocks alone. The [checkout integration tests](../test/integration/real-checkout.integration.spec.ts) cover 20 buyers competing for five units, simultaneous same-key retries, changed content and full-cart rollback. The [messaging](../test/integration/real-messaging.integration.spec.ts) and [scheduler](../test/integration/scheduler.integration.spec.ts) tests cover duplicate delivery, retries and expiration racing activation. Assert accepted quantities, stock and reservation balances, one committed order per key, rollback and successful-step records. Add cross-channel allocation tests when a real ERP agreement exists.

## Question 5: Messaging, resilience, contracts and AI

### Save or publish first?

Neither independent ordering is safe: publishing first can leave a message for a rolled-back order; saving first can leave a committed order with no message. The transactional outbox writes the order and publication intent in the same PostgreSQL transaction. After commit, the [relay](../libs/orders/src/messaging/outbox-relay.ts) claims pending events, publishes to Kafka and acknowledges them in the database.

If the relay crashes after Kafka acknowledges but before the database is updated, the event can be published again. Consumers must therefore be idempotent. Kafka records are keyed by `order_id`, giving partition-local ordering of published records, not global ordering or exactly-once ERP effects. Delayed retries and separately published expiration events can interleave, so the state machine and database locks remain necessary. The local single-broker configuration is not HA.

### Retries, DLQ and recovery

- Activation failures record the failed step, processing state and retry or DLQ intent transactionally. There are at most five attempts, with delays of 1, 2, 4 and 8 seconds plus relay/broker latency. Permanent activation errors schedule an immediate DLQ publication through the outbox.
- Outside that workflow, the [consumer exception filter](../libs/orders/src/adapters/consumer/order-consumer-exception.filter.ts) leaves recognized transient infrastructure failures eligible for Kafka redelivery and sends permanent or unexpected handler failures to the DLQ. A failed direct DLQ publish remains eligible for redelivery. An unexpected error outside activation can leave an order pending or processing and requires investigation.
- Schema-valid events sent directly to the DLQ retain their event payload and diagnostic headers. Malformed events carry only a recognized kind or `UNKNOWN`, source coordinates and reason, not their arbitrary raw payload. The outbox-based terminal DLQ event has its failure details in the local journal.
- Assign a DLQ owner and alert, preserve source coordinates and order history, fix the cause, and use a deliberate replay procedure. Check whether a timed-out ERP request already succeeded before retrying. The repository has no automatic DLQ replay tool or real ERP invoice reconciliation.

### API contracts and testing

The generated [OpenAPI document](../openapi.json) and `/api-docs` describe `GET /products`, `POST /checkout` and `GET /orders/{orderId}/status`, including required `Idempotency-Key` and `X-Environment` headers and success/error schemas. HTTP validation uses Zod, prices are integer cents, and status distinguishes `Pending`, `Active` and `Cancelled` from processing progress. CI regenerates the contract and checks for drift. Kafka events are validated at the consumer boundary; checkout events carry schema version, event ID, correlation/trace context and attempt.

The repository includes unit tests and real-service integration scenarios for cache coordination and fallback, checkout races, outbox recovery, duplicate events, retries, DLQ handling and expiry. It also provides [overselling](../scripts/test-concurrency.ts), [happy-path](../scripts/test-happy-path.ts) and [duplicate-event](../scripts/test-duplicate-checkout-event.ts) scripts. See [verification.md](verification.md) for recorded results and limitations; these tests do not establish production performance, real-provider behavior or global cross-channel consistency.

### Responsible AI use

[PROMPTS.md](../PROMPTS.md) records the relevant requests and review decisions. Examples include:

- “Create an idempotent database seed and a concurrency test script to validate zero-overselling under simultaneous checkout requests.”
- “Refactor the project to use Zod instead of `class-validator`.”
- A request to validate consumer events and handle failures centrally with a DLQ, documented under **Consumer event handling**.

AI suggestions need review against the code, tests and failure modes. In particular, logging an error is not a retry mechanism, cached stock is not a purchase authority, and a local success record cannot guarantee exactly-once effects at a remote provider.
