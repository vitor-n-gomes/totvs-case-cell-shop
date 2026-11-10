# CaseCellShop engineering conventions

- This is a NestJS 11 monorepo with an HTTP API and a Kafka worker. Use Node.js 24 and npm.
- Organize business behavior by feature in `libs/demo` (and future feature libraries). Keep controllers and consumers thin.
- Inject small ports through constructors. Keep request DTOs and TypeORM entities out of event contracts and use-case interfaces.
- Export module dependencies explicitly; do not introduce circular imports, service locators, generic base repositories, or placeholder modules.
- Validate requests, events, and startup configuration. Never log payloads or connection credentials.
- Use explicit migrations. Keep `synchronize` and startup migration execution disabled.
- Acknowledge publication only after Kafka confirms it. Await persistence in consumers and propagate failures for redelivery.
- Preserve duplicate-event safety through database constraints, not an in-memory deduplication check.
- Run `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`, and `npm run build`.
- Integration tests use only the local dedicated test database and an isolated topic/group; see the adjacent testing instructions.
- Keep the challenge's deferred business features documented accurately. Never claim stock consistency or checkout idempotency based on the demo.
