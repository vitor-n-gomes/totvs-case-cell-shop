# Conceptual answers

These answers describe a production direction as well as the smaller executable demonstration. They do not claim that the local simulator integrates with a real ERP or provides globally exclusive inventory across independent sales channels.

## 1. Diagnosis, trade-offs and the 30–90 day architecture

### Storefront performance

**Root cause:** every page request couples storefront latency and availability to the ERP's synchronous workload. Repeated reads compete with operational transactions and amplify under traffic spikes. Adding web replicas alone increases ERP pressure.

**Impact:** slow browsing reduces conversion; ERP contention also slows staff operations and invoicing. Timeouts obscure which dependency caused the problem.

| Strategy                         | Cost and complexity                              | Latency and consistency                                  | Operational effort                        |
| -------------------------------- | ------------------------------------------------ | -------------------------------------------------------- | ----------------------------------------- |
| Cache the existing ERP reads     | Low initial cost                                 | Fast hits; bounded staleness; misses still depend on ERP | TTL, invalidation and stampede handling   |
| Storefront read model plus cache | Moderate; ingestion and ownership rules required | Predictable local reads; eventual synchronization        | Lag monitoring, replay and reconciliation |
| Larger ERP/read replica          | Infrastructure cost; fewer application changes   | May help reads but retains coupling; replica lag matters | Capacity planning and ERP coordination    |

Use a storefront read model plus cache, starting with a bounded cache while building a supported, read-only export/API synchronization path. Do not change ERP tables or routines. A read replica is optional and requires operational approval; it is not a replacement for explicit inventory ownership.

### Overselling

**Root cause:** a check followed by a later write is not atomic. Concurrent buyers observe the same available unit. Stale caches and independently selling channels compound the problem.

**Impact:** cancellations, refunds, support work and loss of trust. Operational stock adjustments become difficult to explain without a reservation ledger.

| Strategy                                    | Cost and complexity                       | Latency and consistency                     | Operational effort                         |
| ------------------------------------------- | ----------------------------------------- | ------------------------------------------- | ------------------------------------------ |
| Conditional database decrement              | Low within one authority                  | Strong local consistency; short transaction | Hot-row contention monitoring              |
| Reservation ledger with conditional updates | Moderate                                  | Strong local allocation plus bounded holds  | Expiration, consumption and reconciliation |
| Redis/distributed lock around purchase      | Additional dependency and lease semantics | Does not itself make database writes atomic | Ownership, fencing and outage handling     |

Use reservations backed by PostgreSQL constraints and atomic updates. The storefront must own an allocated quota, or use an authoritative ERP reservation API, to promise no overselling across channels. If neither is available, strict global prevention is not achievable with periodic stock polling alone.

### Slow ERP invoicing

**Root cause:** customer response time includes a slow external side effect, and timeout handling lacks an end-to-end idempotency protocol. The caller cannot infer whether a timed-out invoice was created.

**Impact:** abandoned purchases, duplicate invoices after retries, stuck orders and difficult support investigations.

| Strategy                                   | Cost and complexity                  | Latency and consistency                      | Operational effort                             |
| ------------------------------------------ | ------------------------------------ | -------------------------------------------- | ---------------------------------------------- |
| Longer synchronous timeouts                | Low implementation cost              | Poor tail latency, ambiguous outcomes remain | Connection exhaustion and retry storms         |
| Queue publication beside database write    | Moderate                             | Fast acceptance but dual-write loss windows  | Manual repair of missing orders/events         |
| Transactional outbox and idempotent worker | Moderate implementation/storage cost | Fast durable acceptance; eventual completion | Relay backlog, retries, DLQ and reconciliation |

Use a transactional outbox and bounded worker processing. `202` means durable acceptance, not successful invoicing. Expose processing state and provide customer communication for delayed/failed orders.

### Delivery sequence

- **Days 1–30:** instrument the current path, establish baseline latency/error/freshness measures, deploy cache-aside with stampede mitigation, introduce the storefront-owned database and inventory ownership agreement. Implement atomic checkout and request idempotency.
- **Days 31–60:** deploy outbox, workers, idempotent ERP requests, bounded retries and DLQ. Add status API, reservation expiration, dashboards and tested recovery procedures. Start incremental read-model synchronization using supported ERP reads.
- **Days 61–90:** harden synchronization/reconciliation, exercise dependency failures and capacity limits, validate SLOs, implement operational replay tooling and scale workers by measured partition/key load. Add HA for required services and review disaster recovery/RPO/RTO.

The local implementation demonstrates the central consistency mechanisms. It does not implement live ERP synchronization, HA infrastructure or automated invoice reconciliation.

## 2. Cache, invalidation and storefront performance

Put static assets behind a CDN. Cache public catalog responses only when cache keys include every price-affecting dimension (currency, region, customer tier, promotion version). Never share personalized prices through an undifferentiated public cache.

Use Redis for the shared catalog read model and optionally a very short per-process cache if measurements justify it. PostgreSQL remains the checkout authority. Separate relatively static descriptions from volatile price/availability data at production scale.

The demonstration caches the static catalog at `storefront:products` for 300 seconds. TTL limits staleness, but does not guarantee a fresh price at every instant. Seed/import operations invalidate after commit. Checkout retrieves current server-side prices and saves immutable snapshots. A production checkout should compare a quote/version accepted by the customer and explicitly reconfirm a changed total before charging.

Cache-aside keeps the initial implementation small. Refresh-ahead can reduce expiry latency for popular keys but needs scheduling, ownership and capacity controls. Use jitter for multiple independently expiring keys; the challenge deliberately uses one key with an exact five-minute TTL. For event-driven invalidation, include a monotonic source version to reject delayed/out-of-order updates and retain TTL as a safety bound.

Local single-flight coalesces requests within a process. A Redis mutex coordinates replicas, with token-checked publish/unlock and a bounded lease. Waiting clients read the winner's result. Owner failure must release via expiry; lock timeouts must not cause unbounded database fan-out. Cache unavailability falls back to the database with bounded queries and local coalescing, with load shedding/circuit breaking added for sustained outages at scale.

Do not cache stock as a purchase authorization. Displayed availability can be advisory, but every checkout must reserve against the authoritative balance. For prices, fail closed or require quote reconfirmation when authoritative data cannot be obtained; silently inventing a price is unacceptable.

Measure cache hit ratio, misses, invalid values, backend loads per miss burst, lock wait/timeout, fallback rate, database/ERP request reduction, endpoint p50/p95/p99, errors and cache/source age. Track price-version mismatches and stock reservation rejection rates separately. A higher hit rate is not a success if freshness breaches or incorrect sales increase.

## 3. Observability, SLOs and operations

Structured logs should contain timestamp, level, service, deployment/environment, event name, correlation/request ID, trace/span IDs, and order/event IDs when applicable. HTTP logs add route template, method, status and duration. Worker logs add topic, partition, offset, attempt, step and classified failure. Include product identifiers only when useful for an inventory investigation; avoid PII, credentials and unbounded payloads.

Counters cover HTTP errors, cache outcomes, accepted/replayed/rejected purchases, reservation transitions, retry/DLQ events and audit loss. Gauges cover oldest outbox age, pending outbox count, consumer lag, active reservation count and reconciliation discrepancies. Histograms cover HTTP, cache load, lock wait, ERP and end-to-end processing duration. IDs belong in logs/traces, not metric labels.

Essential traces:

- `GET /products`: HTTP root → cache lookup/wait → database read on miss → cache publication.
- `POST /checkout`: HTTP root → idempotency lookup/insert → inventory transaction/outbox commit.
- Asynchronous continuation: outbox publication → consumer processing → reservation consumption/activation → ERP → email. Carry the originating trace and event identifiers in message metadata, with explicit parent/link semantics across retries.

The repository emits structured span logs as a justified local stub; it does not configure a tracing backend. Production instrumentation should propagate W3C trace context, sample without losing important errors, and export through a collector.

Initial SLO proposals: 99.9% valid HTTP availability over 30 days; catalog p95 below 200 ms; checkout acceptance p95 below 300 ms; 99% async completion below 60 seconds when dependencies are healthy. Define end-to-end customer SLIs separately so excluding dependency incidents does not hide actual customer impact. Overselling and invoice duplication are correctness invariants, not acceptable error-budget consumption.

Dashboards should show the full funnel from request through acceptance to completed activation, overlaid with dependency health and deployment markers. Alert on sustained latency/error burn, growing oldest-event age, any DLQ arrival, reservation discrepancies and failed reconciliation. Use multi-window error-budget burn to balance fast detection and noise. Assign a named owning team and escalation path in a real deployment.

Runbooks in the README cover cache outages, backlog, retry/DLQ investigation, terminal order handling and stock/invoice reconciliation. Each incident should preserve identifiers and history, repair the dependency, resume safe work and verify that backlog and customer impact actually recover.

## 4. Concurrency, inventory and idempotency

With one unit available, requests A and B can both read one before either writes. A later decrement can oversell even when each handler contains an `if (stock > 0)` check. The decision and modification must be one atomic operation or protected by a database transaction lock.

| Mechanism                 | Strength                                                               | Trade-off                                                                    |
| ------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Conditional atomic update | Cheap, authoritative admission decision in one statement               | Hot products serialize on their rows; application must inspect affected rows |
| Pessimistic locking       | Clear multi-record invariant checking                                  | Longer transactions, deadlocks and lock-wait budgets                         |
| Reservations              | Explicit lifecycle for asynchronous processing and abandoned purchases | Must atomically reserve, consume and expire, with cleanup/reconciliation     |
| Distributed locks         | Useful for cache coordination or ownership                             | Lease loss is not a database fence; cannot replace database constraints      |

The implementation combines conditional reservation updates, database constraints and row locks for consumption/expiration. It orders product operations consistently, uses short transactions and never holds database transactions across ERP calls. An order-scoped advisory lock serializes worker attempts; correctness of stock remains enforced in the database.

HTTP idempotency uses a unique persisted key plus canonical request hash. The same key/content returns the original acceptance; conflicting content returns `409`. The order, reservation, item snapshot and outbox share one transaction, so a failed purchase does not consume the key permanently. On an ambiguous network timeout, clients retry the same key.

Worker idempotency is separate: unique successful step records make redelivery and restart safe. Database effects and their success records commit together. Remote effects require provider idempotency or lookup because a crash can occur after the remote operation but before the local success record. Kafka delivery semantics alone cannot close that window.

Tests must run against the actual database, not only mocked repositories: many buyers for fewer units, repeated identical keys, conflicting payloads, multi-item rollback, duplicate events, consumption versus expiry, and interrupted processing. Assert final balances, accepted order counts, one success per step, and absence of negative/reserved-above-physical stock. Add cross-channel allocation tests when integrating the ERP.

## 5. Messaging, contracts and critical AI usage

Publishing before saving can create a ghost message for an order that rolls back. Saving before publishing can leave a committed order without its message. A transactional outbox stores the business change and publication intent together; a relay retries publication independently. A crash after publication but before marking the outbox processed yields a duplicate, so consumers must be idempotent.

Kafka messages are keyed by order ID. Partition ordering is useful but does not provide global ordering or exactly-once external effects. Retried attempts are explicitly numbered; the worker rejects incompatible events and ignores recorded attempts. Successful handling or durably recording a retry/DLQ intent precedes offset advancement.

Transient business/integration failures get bounded exponential delays. Permanent failures go directly to a DLQ; exhausted transient attempts do likewise. A broker outage must not discard DLQ intent. Infrastructure failures that prevent recording any outcome keep the original message unresolved. Avoid an endless tight retry loop and retain heartbeats during dependency recovery.

A DLQ requires ownership, alerts, diagnostic context, retention and a deliberate replay process. Do not automatically replay terminal failures forever. Confirm whether the ERP already invoiced before retrying an ambiguous timeout. Reconcile stock reservations and invoice state periodically, using stable external IDs and a clear compensation policy.

OpenAPI is generated from the actual DTOs/controllers and checked for drift in CI. It documents success/error schemas, header requirements, validation limits, decimal string prices and the difference between accepted, active and fully processed orders. A versioned, strict event schema protects the worker boundary. Additive migrations preserve the existing demo tables and APIs; deploy migrations and topics before new application versions.

Tests combine isolated unit behavior with real HTTP/PostgreSQL/Redis/Kafka integration, including failure injection and race conditions. Container smoke checks validate actual entry points and runtime dependency packaging. Setup and verification results are recorded without labeling unavailable or failed checks as successful.

AI supplied implementation scaffolding and test ideas under an approved plan. Human-directed review corrected omissions in the original task prompts: logging does not implement Kafka retries, success logs alone cannot guarantee external exactly-once effects, stock cached for display cannot authorize purchases, and ACTIVE precedes ERP completion in this chosen workflow. `PROMPTS.md` records the requests, resulting decisions, review findings and actual validation instead of presenting generated code as self-validating.
