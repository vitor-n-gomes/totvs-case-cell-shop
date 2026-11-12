# Compilation of AI Code Generation Tasks

This document contains prompts organized to be executed sequentially in AI coding assistants (like Copilot, Cursor, or ChatGPT integrated into VS Code) to generate the entire architecture for the challenge.

## 🚨 GLOBAL RULES FOR THE AI (READ BEFORE GENERATING CODE)

1. **Naming Convention:** Use the domain `Order` (instead of Contract) throughout the system. Ensure all code is written in English.

2. **Database (snake_case):** All database columns and tables MUST strictly use `snake_case` (e.g., `payment_type`, `created_at`, `order_id`). In TypeScript classes/entities, use `camelCase` and map them accordingly in the ORM.

3. **Migrations:** Any table creation or alteration mentioned in these tasks MUST be accompanied by its respective **Migration** file in the chosen framework (e.g., TypeORM, Prisma, etc.).

---

### Task 1: Domain Tables (Orders and Products)

"Create the domain entities, repositories, and migrations for the following tables:

1. `order`: `id` (PK, UUID), `payment_type` (Enum: PrePaid, PostPaid), `due_date` (Date), `main_contact` (Varchar), `alt_contact` (Varchar nullable), `payment_method` (Varchar), `environment` (Enum: Local, PreProd, Prod), `status` (Enum: Pending, Active, Cancelled).

2. `product`: Static catalog containing `id` (PK), `name` (Varchar), `product_key` (Varchar/Slug), `net_price` (Decimal), `list_price` (Decimal). It must NOT contain quantity.
   Remember to use `snake_case` in the database and create the migrations."

---

### Task 2: Domain Tables (Stock and Reservation)

"Create the entities, repositories, and migrations for the tables focused on concurrency control and preventing _overselling_:

1. `stock`: `id` (PK), `product_id` (FK), `physical_quantity` (Int), `reserved_quantity` (Int).

2. `stock_reservation`: `id` (PK), `order_id` (FK), `product_id` (FK), `quantity` (Int), `status` (Enum: ACTIVE, CONSUMED, EXPIRED), `expires_at` (Timestamp).
   The available balance will always be `physical_quantity - reserved_quantity`."

---

### Task 3: Infrastructure and Resilience Tables

"Create the entities, repositories, and migrations for the following support tables:

1. `idempotency_log`: `id` (PK), `order_id` (FK), `action` (Varchar), `reference` (JSON - for error payloads), `step` (Varchar), `success` (Boolean), `description` (Text).

2. `outbox_events`: `id` (PK), `order_id` (FK), `topic` (Varchar), `payload` (JSON), `status` (Enum: PENDING, PROCESSED).

3. `request_log`: `id` (PK), `url` (Varchar), `method` (Varchar), `payload` (JSON), `correlation_id` (Varchar, indexed). No updated_at column."

---

### Task 4: Base Structure and Steps Interface

"Create the folder structure for the `ActiveOrderUseCase` with the following folders: `constants`, `decorators`, `guards`, `registries`, `steps`, and `strategies`.
Inside the `steps` folder, create the `ActivationStep` interface with the methods:

- `exec(context: ActivationContext): Promise<void>`
- `shouldExecute?(context: ActivationContext): boolean`

The `ActivationContext` must contain the complete `Order`, the `correlationId`, and other necessary dependencies."

---

### Task 5: Activation Steps Implementation

"Create the following implementations of the `ActivationStep` interface:

1. `ConsumeStockReservationStep`: Fetches the `stock_reservation` for the Order (status ACTIVE). If expired, throws a `ReservationExpiredError`. If valid, changes to CONSUMED and updates the `stock` table (subtracting from both physical and reserved quantities) inside a database transaction.

2. `ActivateOrderStep`: Updates the Order status to `Active`.

3. `UpdateErpStep`: Simulates the billing request to the ERP (can just be a log/delay).

4. `EmailNotificationStep`: Simulates sending a success email.
   (Use the `idempotency_log` table in all steps to skip those that were already executed successfully and to generate a DLQ on unrecoverable failures)."

---

### Task 6: Orchestration Strategy

"Create the `OnlineActivationStrategy` class that will implement the execution logic of the steps created in the previous task.
It must have a `stepNames` array with the exact priority:

1. ConsumeStockReservationStep
2. ActivateOrderStep
3. UpdateErpStep
4. EmailNotificationStep

The strategy must iterate through this array calling `exec()`. If any error occurs, it must interrupt the flow and register the failure in the `idempotency_log`."

---

### Task 7: Storefront API and Cache Stampede (GET /products)

"Create the controller and the use case for the `GET /products` HTTP route.
Rules:

1. Implement _Cache-Aside_ using Redis. Key: `storefront:products` (TTL: 5 min).
2. Implement **Cache Stampede** mitigation (Single-Flight/Mutex). If the cache misses, only the 1st request goes to the database; concurrent requests must wait and read from the newly populated cache.
3. Generate logs with `correlation_id` and metrics (hits/misses) using prom-client."

---

### Task 8: Checkout and Transactional Outbox (POST /checkout)

"Create the controller and use case for `POST /checkout`.
Logic must run inside a SINGLE Database Transaction:

1. Create the `Order` with PENDING status.
2. Create the `stock_reservation` to temporarily secure the items.
3. Create the record in `outbox_events` with the `order.checkout.initiated` payload.
   If everything succeeds, commit the transaction and return `202 Accepted` with the `order_id`."

---

### Task 9: Order Status API

"Create the controller and use case for the `GET /orders/{order_id}/status` HTTP route. It must query the `order` table and return basic data along with the current order status."

---

### Task 10: Scheduler - Outbox Relay (Kafka)

"Create a Cron Job (Relay) service/app running continuously.
It must:

1. Read `PENDING` records in the `outbox_events` table.
2. Publish the message to the corresponding Kafka topic, using the `order_id` as the Message Key (to guarantee ordering within partitions).
3. After successful dispatch, mark the record as `PROCESSED`."

---

### Task 11: Messaging - Kafka Consumer (Worker)

"Create a Kafka Consumer to listen to the `order.checkout.initiated` topic.
The worker must:

1. Receive the event (with `order_id` and `correlation_id`).
2. Inject the `correlation_id` into the logger context.
3. Invoke the `OnlineActivationStrategy` (Task 6).
4. In case of an unrecoverable error in the strategy, use an error log so Kafka manages Retries/DLQ."

---

### Task 12: Scheduler - Expired Stock Release (Reconciliation)

"Create a Cron Job (e.g., `@Cron('*/5 * * * *')`) for reservation cleanup.
It must process unpaid reservations (abandoned carts):

1. Fetch `stock_reservation` records where `status = 'ACTIVE'` and `expires_at <= NOW()` in batches (LIMIT 1000).
2. Update the reservation status to `EXPIRED`.
3. Return the `reserved_quantity` back to the `stock` table.
4. Update the corresponding `Order` status to `Cancelled`."

---

### Task 13: Global Observability (Pino and Interceptor)

"Configure the `pino` and `prom-client` libraries for observability:

1. Create a Global Interceptor to intercept POST/PUT/DELETE requests.
2. The Interceptor must generate a `correlation_id` (if not provided) and save the data (`url`, `method`, `payload`) into the `request_log` table ASYNCHRONOUSLY to avoid latency overhead.
3. Inject this `correlation_id` into the JSON logs that Pino will output to `stdout` (simulating Datadog ingestion).
4. Create the `GET /metrics` endpoint exposing business and cache metrics."
