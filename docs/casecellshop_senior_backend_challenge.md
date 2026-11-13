# Technical Challenge - CaseCellShop
**Senior Level | Backend**  
*Fictional company. Case used exclusively for technical evaluation purposes.*

---

## Quick Summary

- **Format:** Conceptual questions + practical backend mini-task.
- **Objective:** Evaluate depth in backend engineering, caching, observability, concurrency, resilience, and critical AI usage.
- **AI Usage:** Allowed and encouraged. As a senior engineer, direct the AI thoughtfully, review responses, and record relevant prompts.
- **Delivery:** Conceptual responses + public GitHub repository + `README.md` + `PROMPTS.md` (when applicable). Prioritize a clear, executable delivery.
- **Preferred Stack:** Node.js + TypeScript on the backend due to alignment with the expected technical environment. If you prefer another stack, that is fine—explain your choice briefly in the `README` and ensure the project is easy to run.
- **Support Services:** Use local/simulated resources: in-memory data, local database, local Redis/queue, Docker Compose, LocalStack, or mocks. Datadog is a conceptual reference; a real account is not required.

---

## Evaluation Criteria & Correction Method

The following aspects will be primarily evaluated:
- Root cause analysis, risks, and trade-offs.
- **Cache:** TTL, invalidation, fallback, and cache stampede prevention.
- **Observability:** Logs, metrics, traces, SLOs, alerts, and runbooks.
- **Checkout Consistency:** Idempotency, concurrency, and stock consistency.
- **Asynchronous Resilience:** Retries, Dead Letter Queue (DLQ), and reconciliation.
- Tests, API contracts, implementation, and responsible AI usage.

---

## Context & Current Architecture

You have been hired as a Senior Backend Developer at **CaseCellShop**, a retail company focused on selling phone cases. The company is experiencing hypergrowth: daily traffic has jumped from thousands to millions of requests.

### Current System Setup

| Component | Description |
| :--- | :--- |
| **Central ERP** | Monolith managing inventory, invoicing, finance, and accounting. The core of the company. |
| **Storefront (Loja Virtual)** | E-commerce platform that consumes products, prices, and stock directly from the ERP via synchronous REST API. |
| **Database** | ERP uses MySQL. Read access is available, but altering ERP routines, tables, or internal code is strictly prohibited. |
| **Infrastructure** | Hosted in an on-premises datacenter, with plans to evolve toward more scalable services. |
| **Monitoring** | Basic performance alerts with minimal traceability per order, product, or request. |

---

## The 3 Key Issues Identified

Due to the drastic increase in traffic, three main technical issues have been identified:

1. **Storefront Performance:** The storefront queries the ERP on every page access, causing severe slowdowns. The business needs lower latency without displaying stale or incorrect prices and inventory.
2. **Stock Consistency:** Multiple customers are purchasing the same item when stock is exhausted. The solution must strictly prevent overselling.
3. **Checkout Resilience:** The ERP API is slow to invoice orders. The checkout journey must tolerate timeouts, handle retries, and support asynchronous processing without losing traceability.

---

## Part 1.A - Conceptual Questions

*Guidance: Answer in text, bullet points, or simple diagrams. Writing code is not required for this part.*

### Question 1: Diagnosis, Trade-Offs, and Target Architecture
For each of the 3 identified issues:
- What do you believe is causing the problem at its **root**, not just the surface symptom?
- What is the impact on the customer, business, and operations?
- Compare 2 to 3 solution strategies considering cost, complexity, latency, consistency, and operational effort.
- Provide a target architecture vision for 30 to 90 days, detailing caching, queues, store-owned database, workers, sync mechanisms, observability, and ERP reconciliation.

### Question 2: Cache, Invalidation, and Storefront Performance
Regarding the product, pricing, and inventory catalog:
- Where would you place caching layers? Explain the role of each layer.
- Detail strategy for TTL, invalidation, cache-aside vs. refresh-ahead, fallbacks, and cache stampede prevention.
- Define specific metrics to validate performance/cost gains without delivering stale or incorrect data.

### Question 3: Observability (Datadog or Equivalent)
Leadership wants to detect performance degradation and inventory discrepancies before customer complaints occur. Without requiring a real vendor account:
- What structured logs would you instrument? Which fields are mandatory?
- What metrics (counters, gauges, histograms) would you create for cache, checkout, queues, and ERP integrations?
- What distributed traces/spans are essential for `GET /products` and async `POST /checkout` flows?
- What SLIs/SLOs, alerts, dashboards, and runbooks would you configure?

### Question 4: Concurrency, Inventory, and Idempotency
Regarding stock overselling during checkout:
- Explain why a simple stock check before purchase is insufficient. Compare conditional atomic updates, pessimistic locking, stock reservation, and distributed locks.
- How would you implement idempotency to tolerate retries, double-clicks, and re-processing? How would you test that overselling is prevented?

### Question 5: Messaging, Resilience, API Contracts, and AI
Regarding asynchronous checkout and delivery:
- Would you publish the message to the queue *before* or *after* saving the order? How do you prevent ghost orders or ghost messages?
- Cover retry mechanisms, DLQ patterns, OpenAPI contracts, testing strategies, and relevant AI prompts used.

---

## Part 1.B - Practical Backend Mini-Task

*Guidance: Push your code to a personal public GitHub repository and include the link in your final response. Keep the solution concise, focused, and executable.*

### Scope
Implement a lightweight backend service for CaseCellShop that:
1. Exposes a product catalog backed by a cache mechanism.
2. Triggers an asynchronous checkout process.
3. Allows querying the status of an order.

*Use in-memory data or simulated local services as needed. The goal is to demonstrate senior-level backend architectural thinking, caching, observability, and consistency—not to build a full e-commerce system. Document any simplifications made for the challenge scope.*

### Expectations & Deliverables Checklist

#### Backend, API, Cache & Contracts
- [ ] `GET /products` returns products and utilizes caching with TTL or an equivalent strategy.
- [ ] `POST /checkout` initiates a purchase and returns `202 Accepted` with an `orderId` and status.
- [ ] `GET /orders/{orderId}/status` enables tracking order processing status.
- [ ] Includes an OpenAPI specification or equivalent API contract with success and error schemas.

#### Observability
- [ ] Structured logs include `correlationId`/`requestId` (and `orderId` when applicable).
- [ ] Relevant metrics are exposed (including cache hit/miss rates and checkout/queue processing).
- [ ] Traces/spans (real or justified stubs) link requests across cache, repository mocks, and background workers.
- [ ] `README.md` includes examples of Datadog (or equivalent) dashboards, alerts, or runbooks.

#### Concurrency, Async & Delivery
- [ ] Checkout prevents overselling via atomic updates, locking, reservation, or coherent simulation.
- [ ] Simple idempotency handling for retries/double-clicks, with a worker simulating order dispatch to the ERP.
- [ ] Automated tests covering business logic, caching behavior, and concurrency scenarios.
- [ ] `README.md` documents architecture decisions, trade-offs, limitations, setup instructions, and AI prompts used (`PROMPTS.md`).

---

## Submission Summary

1. Written responses to the 5 conceptual questions (Part 1.A).
2. Public GitHub repository link containing the code (Part 1.B).
3. `README.md`, OpenAPI spec/contract, and `PROMPTS.md` (when applicable).