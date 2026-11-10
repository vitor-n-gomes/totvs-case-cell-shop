# Local integration testing

Run `npm run infra:up`, copy `.env.test.example` to `.env.test.local`, then run `npm run test:integration`.

- Never load the application's `.env` or `.env.local` as an integration-test fallback.
- Require a local PostgreSQL database ending in `_test` and Redis database `/1`.
- Create a unique Kafka topic and consumer group per suite; disable automatic topic creation.
- Run explicit migrations against the dedicated test database. Never enable schema synchronization.
- Use bounded polling to observe asynchronous completion. Avoid fixed sleeps as evidence of consumption.
- Delete only the suite's receipts and cache keys, then delete its topic/group.
- Close apps and clients in cleanup, including partial initialization failures. Do not use `forceExit` to hide resource leaks.
- Prefer assertions on visible behavior and consistency guarantees. Do not make network calls to AWS, an ERP, or any production database.
- Keep no-service unit tests separate from real-service integration tests. Unavailable infrastructure is not a passing integration test.
