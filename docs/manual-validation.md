# Validação manual da refatoração de Orders

Esta etapa não executa nem corrige testes unitários ou de integração. O roteiro abaixo é para validação manual em ambiente local. Os comandos de compra consomem estoque desse ambiente. Use uma chave nova em cada cenário, exceto nos cenários explícitos de replay.

## Preparação

Use Node 24 conforme `.nvmrc`. Se ainda não houver configuração local, copie `.env.example` para `.env`. Variáveis do processo prevalecem sobre `.env.local`, que prevalece sobre `.env`. Preserve arquivos locais já configurados.

```bash
nvm use
npm run infra:up
npm run infra:init
npm run migration:run
npm run seed
npm run typecheck:app
npm run build
```

Inicie em dois terminais:

```bash
npm run start:dev
npm run consumer:debug
```

Alternativa com containers:

```bash
docker compose up -d --build --wait http consumer
docker compose run --rm migrate npm run seed
```

A API atende na porta 3000; o consumer expõe apenas health checks e métricas na 3001. `API_PORT` e `WORKER_PORT` continuam válidos. `API_HOST_PORT` / `WORKER_HOST_PORT` alteram apenas as portas publicadas pelo Compose.

Confirme `GET /health/ready` nas duas portas, `GET /products`, `/api-docs` na API e `/metrics` nas duas aplicações. Confirme também que `POST /checkout` não existe na porta do consumer.

## Criação, consulta e idempotência

```bash
curl -i http://localhost:3000/checkout \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: manual-orders-001' \
  -H 'x-correlation-id: 4c79764b-416c-4c29-939c-48eb86649ac3' \
  -d '{"paymentType":"PrePaid","dueDate":"2026-11-11","mainContact":"manual@example.test","paymentMethod":"PIX","environment":"Local","items":[{"productId":"11111111-1111-4111-8111-111111111111","quantity":1}]}'

curl -s http://localhost:3000/orders/ORDER_ID/status
```

O POST deve retornar `202` com `{ "orderId": "…", "status": "Pending" }`. A consulta deve mostrar os itens com preços em strings decimais e evoluir para `Active` / `Completed`. Ela não expõe os contatos.

Repita exatamente a requisição: deve retornar o mesmo ID e a mesma resposta de aceite, mesmo após a ativação. Repita a chave alterando a quantidade: deve retornar `409`. Envie a mesma chave e conteúdo simultaneamente em dois terminais: ambos devem obter o mesmo pedido, com uma única reserva por produto.

Confira o banco, substituindo `ORDER_ID` nas consultas. Abra o psql com `docker compose exec postgres psql -U casecellshop -d casecellshop`:

```sql
SELECT id, status, processing_status, last_attempt FROM "order" WHERE id = 'ORDER_ID';
SELECT product_id, quantity, net_price, list_price FROM order_item WHERE order_id = 'ORDER_ID';
SELECT product_id, quantity, status, expires_at FROM stock_reservation WHERE order_id = 'ORDER_ID';
SELECT topic, status, deduplication_key FROM outbox_events WHERE order_id = 'ORDER_ID';
SELECT step, success, reference FROM idempotency_log WHERE order_id = 'ORDER_ID' ORDER BY created_at;
```

Ao concluir, devem existir quatro etapas bem-sucedidas, sem duplicação de sucesso, e reserva `CONSUMED`. O payload da outbox continua com `schema_version`, `event_id`, `order_id`, `correlation_id`, `occurred_at`, `attempt`, `trace_id` e `parent_span_id`, sem envelope `kind/data/meta`.

## Rejeições e rollback

- Sem chave ou com itens repetidos: `400`.
- Produto inexistente com UUID válido: `404`.
- Quantidade maior que a disponível: `409`.
- Carrinho com um item disponível e outro inexistente/insuficiente: falha integral. Não devem restar pedido, itens, reserva nem evento inicial para a chave usada; o saldo reservado do primeiro item deve permanecer igual ao anterior.
- Dois pedidos simultâneos disputando o saldo restante: o total reservado deve respeitar o estoque físico.

Antes e depois dos cenários, confira:

```sql
SELECT product_id, physical_quantity, reserved_quantity FROM stock ORDER BY product_id;
SELECT id FROM "order" WHERE idempotency_key = 'CHAVE_DO_CENARIO';
```

## Retry, DLQ e repetição de mensagens

Reinicie somente o consumer com `ERP_FAILURES=2` no ambiente do processo (no Compose, ajuste a variável do serviço antes de recriá-lo). Crie um novo pedido. Ele deve completar na terceira tentativa, mantendo quatro registros de sucesso e duas falhas no histórico. Consumo do estoque e ativação não devem se repetir. Volte `ERP_FAILURES` para zero depois.

Com `SIMULATOR_PERMANENT_FAILURE=erp`, um novo pedido deve ficar `Active` / `Failed`, com evento na DLQ. O estoque já consumido não é reposto automaticamente. Com `ERP_FAILURES=5`, confira o esgotamento em cinco tentativas. Com falha transitória de email, o ERP já concluído não deve repetir a etapa.

Na UI Kafka local (`http://localhost:8080`, serviço opcional `docker compose up -d kafka-ui`), copie um evento válido e republique no mesmo tópico. Mantenha a chave `order_id` e o payload original: a repetição não pode consumir estoque ou repetir etapas concluídas. Envie também um JSON inválido para o contrato: ele deve ir à DLQ com tópico/partição/offset e motivo, sem registrar o payload arbitrário.

## Expiração

Pare o consumer e reinicie a API com `RESERVATION_TTL_SECONDS=1`. Crie um pedido e aguarde o vencimento. Reinicie o consumer com `RESERVATION_TTL_SECONDS=1`: o consumo de uma reserva vencida deve falhar permanentemente, liberá-la e cancelar o pedido pendente.

Para conferir especificamente o job de limpeza, deixe o consumer na configuração normal e crie um tópico temporário sem consumidor:

```bash
docker compose exec kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:19092 --create --if-not-exists --topic order.checkout.manual-expiration --partitions 1 --replication-factor 1
```

Reinicie somente a API com `CHECKOUT_TOPIC=order.checkout.manual-expiration RESERVATION_TTL_SECONDS=1 npm run start:dev`. Crie um pedido e aguarde o ciclo de cinco minutos do scheduler: o relay publicará o evento no tópico temporário, enquanto o job deverá cancelar o pedido e liberar a reserva uma única vez. O consumer continua inscrito apenas no tópico normal. Depois, reinicie a API na configuração padrão, com TTL de 900 segundos. Não reutilize o tópico temporário para pedidos normais.

## Recuperação e logs

Com a API já iniciada, pare Kafka (`docker compose stop kafka`) e crie um pedido. O aceite deve continuar em `202`, com pedido, itens, reserva e outbox persistidos. O consumer deve indicar indisponibilidade em readiness. Reinicie Kafka (`docker compose start kafka`): a outbox pendente deve ser publicada e o pedido processado uma única vez dentro do TTL. Para pedidos vencidos, o resultado esperado é cancelamento.

Confira também o primeiro acesso da API ao Kafka: inicie a API com o broker parado, faça uma publicação na demo (falha temporária), restaure o broker e repita. A conexão inicial rejeitada não pode impedir a recuperação do publisher. `POST /demo/messages` e `GET /demo/messages/:eventId` devem continuar funcionando.

Os logs devem ser JSON via `nestjs-pino`, com correlação, pedido e identificadores de trace/span quando aplicáveis. Contatos, corpo da requisição, senhas e credenciais Kafka não devem aparecer. Inspecione as métricas de aceite/replay/rejeição, reservas, processamento e backlog da outbox.

Credenciais externas ficam a cargo do operador: configure `KAFKA_SSL` e, quando necessário, `KAFKA_SASL_MECHANISM` (`plain`, `scram-sha-256` ou `scram-sha-512`), `KAFKA_SASL_USERNAME` e `KAFKA_SASL_PASSWORD`. Todos os componentes Kafka usam a mesma configuração central. O ambiente Docker local continua sem autenticação.
