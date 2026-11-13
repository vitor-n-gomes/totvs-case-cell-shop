# Event-Driven Architecture Documentation

## 1. Visão Geral

### Problema
A implementação anterior tinha lógica acoplada em `ProcessOrderEventUseCase`, donde todos os handlers de eventos estavam concentrados em um único lugar, dificultando:
- Escalabilidade: adicionar novos tipos de eventos era complexo
- Manutenibilidade: mudanças em um handler podiam afetar outros
- Testabilidade: testes unitários precisavam mockar toda a lógica

### Solução
Implementamos um **EventBus** com **handlers dedicados por tipo de evento**, seguindo o padrão pub/sub:
- Cada tipo de evento tem seu próprio handler
- Handlers são registrados no EventBus
- Eventos são despachados para todos os handlers registrados de forma **desacoplada**

### Benefícios
✅ **Escalável**: Adicionar novos eventos é apenas criar um novo handler  
✅ **Desacoplado**: Handlers não dependem uns dos outros  
✅ **Fácil de testar**: Cada handler pode ser testado isoladamente  
✅ **Rastreável**: Metadados de correlação em todos os eventos  

---

## 2. Arquitetura

### Estrutura de Aplicações

```
totvs-case-cell-shop/
├── apps/
│   ├── scheduler
│   │   └─ Cronos que emitem eventos genéricos para expirações de reserva
│   ├── consumer
│   │   └─ Consome eventos do Kafka e delega aos handlers via EventBus
│   └── http (sem mudanças)
│
├── libs/order/src/
│   ├── domain/events/
│   │  ├─ order.event.ts (tipos genéricos)
│   │  └─ index.ts (exports)
│   │
│   ├── adapters/handlers/
│   │  ├─ event.handler.ts (interface para handlers)
│   │  ├─ event.bus.ts (service de pub/sub)
│   │  ├─ handlers.registry.ts (registry de handlers)
│   │  └─ order-activated.handler.ts (handler de ativação)
│   │
│   ├── adapters/usecases/
│   │  ├─ process-order-event.use-case.ts (consome events do Kafka)
│   │  ├─ expire-reservations.use-case.ts (scheduler cron)
│   │  └─ event-handlers/ (handlers de domínio)
│   │     ├─ checkout-initiated.handler.ts
│   │     └─ reservation-expired.handler.ts
│   │
│   └── activation/
│      └─ strategies/online-activation.strategy.ts (emite eventos)
```

---

## 3. Estrutura de Eventos

### Interface Genérica

```typescript
/**
 * Metadados associados com cada evento
 * Rastreia correlação e informações de trace para sistemas distribuídos
 */
interface OrderEventMeta {
  /** Identificador único para correlacionar eventos relacionados */
  correlationId: string;

  /** ID de trace para distributed tracing (ex: OpenTelemetry) */
  traceId: string;

  /** ID opcional do span pai para tracing hierárquico */
  parentSpanId?: string;

  /** Unix timestamp (milliseconds) quando o evento foi criado */
  timestamp: number;
}

/**
 * Interface genérica base para todos os eventos de order
 */
interface OrderEvent<T = any> {
  /** Identificador do tipo de evento (ex: "order.activated", "ORDER_RESERVATION_EXPIRED") */
  kind: string;

  /** Payload específico do evento */
  data: T;

  /** Metadados de correlação e rastreamento */
  meta: OrderEventMeta;
}
```

### Exemplo Concreto

```typescript
// Evento de order ativado
const orderActivatedEvent: OrderEvent<{ orderId: string }> = {
  kind: 'order.activated',
  data: { orderId: '123e4567-e89b-12d3-a456-426614174000' },
  meta: {
    correlationId: '550e8400-e29b-41d4-a716-446655440000',
    traceId: 'a1b2c3d4e5f6g7h8',
    parentSpanId: 'p1q2r3s4',
    timestamp: 1699814822000,
  }
};
```

---

## 4. Tipos de Eventos Implementados

| Evento | Kind | Emitido Por | Descrição |
|--------|------|-------------|-----------|
| **ORDER_CHECKOUT_INITIATED** | `ORDER_CHECKOUT_INITIATED` | `CheckoutUseCase` | Novo checkout iniciado (entrada do consumer) |
| **ORDER_RESERVATION_EXPIRED** | `ORDER_RESERVATION_EXPIRED` | `ExpireReservationsUseCase` (scheduler) | Reserva de stock expirou |
| **ORDER_ACTIVATED** | `order.activated` | `OnlineActivationStrategy` | Order foi ativada com sucesso |
| *(future)* | `ORDER_CHECKOUT_FAILED` | - | Checkout falhou |
| *(future)* | `ORDER_EVENT_INVALID` | - | Evento inválido recebido |

---

## 5. Handlers Implementados

### 1. OrderActivatedHandler
**Localização**: `libs/order/src/adapters/handlers/order-activated.handler.ts`

```typescript
@Injectable()
export class OrderActivatedHandler implements EventHandler<{ orderId: string }> {
  kind = 'order.activated';

  constructor(
    private readonly logger: AppLogger,
    private readonly orderRepository: OrderRepository,
    private readonly metrics: Metrics,
  ) {}

  async handle(event: OrderEvent<{ orderId: string }>): Promise<void> {
    const { orderId } = event.data;
    const order = await this.orderRepository.findById(orderId);
    
    if (!order) {
      this.logger.error('order.activated.handler.order_not_found', { orderId });
      return;
    }

    // Lógica pós-ativação
    this.metrics.reservations.inc({ result: 'activated' });
  }
}
```

### 2. CheckoutInitiatedHandler
**Localização**: `libs/order/src/adapters/usecases/event-handlers/checkout-initiated.handler.ts`

```typescript
@Injectable()
export class CheckoutInitiatedHandler {
  constructor(private readonly activation: ActiveOrderUseCase) {}

  async execute(event: CheckoutInitiatedEvent): Promise<void> {
    // Ativa a order quando checkout é iniciado
    return this.activation.execute(event);
  }
}
```

### 3. ReservationExpiredHandler
**Localização**: `libs/order/src/adapters/usecases/event-handlers/reservation-expired.handler.ts`

```typescript
@Injectable()
export class ReservationExpiredHandler
  implements EventHandler<{ orderId: string }> {
  kind = 'ORDER_RESERVATION_EXPIRED';

  constructor(
    private readonly database: DataSource,
    private readonly orders: OrderRepository,
    private readonly reservations: ReservationRepository,
    private readonly metrics: Metrics,
  ) {}

  async handle(event: OrderEvent<{ orderId: string }>): Promise<void> {
    // Libera stock, cancela order, incrementa métrica
    const orderId = event.data.data.order_id;
    
    const released = await this.database.transaction(async (manager) => {
      const order = await this.orders.lock(manager, orderId);
      if (order?.status !== OrderStatus.Pending) return 0;
      
      const count = await this.reservations.release(manager, orderId);
      await this.orders.update(manager, orderId, {
        status: OrderStatus.Cancelled,
      });
      return count;
    });

    if (released) {
      this.metrics.reservations.inc({ result: 'expired' }, released);
    }
  }
}
```

---

## 6. Componentes Principais

### EventBus - Orquestrador Central
**Localização**: `libs/order/src/adapters/handlers/event.bus.ts`

```typescript
@Injectable()
export class EventBus implements IEventBus {
  private handlers: Map<string, EventHandler[]> = new Map();

  /**
   * Registra um handler para um tipo de evento
   */
  register(handler: EventHandler): void {
    const kind = handler.kind;
    if (!this.handlers.has(kind)) {
      this.handlers.set(kind, []);
    }
    this.handlers.get(kind)!.push(handler);
  }

  /**
   * Despacha um evento para todos os handlers registrados
   * Executa handlers em paralelo com tratamento de erros
   */
  async dispatch(event: OrderEvent): Promise<void> {
    const handlers = this.handlers.get(event.kind);
    if (!handlers) return;

    const handlerPromises = handlers.map((handler) =>
      handler.handle(event).catch((error) => {
        this.logger.error(`Handler failed for event: ${event.kind}`, { error });
      })
    );

    await Promise.all(handlerPromises);
  }

  /**
   * Publica um evento no Kafka
   */
  async publish(event: OrderEvent, topic?: string): Promise<void> {
    await this.messaging.publish(kafkaTopic, event.meta.correlationId, event);
  }
}
```

### HandlersRegistry - Registro de Handlers
**Localização**: `libs/order/src/adapters/handlers/handlers.registry.ts`

```typescript
@Injectable()
export class HandlersRegistry {
  constructor(
    private readonly checkoutInitiatedHandler: CheckoutInitiatedHandler,
    private readonly reservationExpiredHandler: ReservationExpiredHandler,
    private readonly orderActivatedHandler: OrderActivatedHandler,
  ) {}

  /**
   * Registra todos os handlers no EventBus
   */
  registerAll(eventBus: EventBus): void {
    const handlers = [
      this.checkoutInitiatedHandler,
      this.reservationExpiredHandler,
      this.orderActivatedHandler,
    ];

    handlers.forEach((handler) => {
      eventBus.register(handler as any);
    });
  }
}
```

### EventHandler - Interface de Handlers
**Localização**: `libs/order/src/adapters/handlers/event.handler.ts`

```typescript
/**
 * Interface genérica para handlers de eventos
 */
export interface EventHandler<T = any> {
  /** Identificador do tipo de evento que este handler processa */
  kind: string;

  /** Processa o evento recebido */
  handle(event: OrderEvent<T>): Promise<void>;
}
```

---

## 7. Fluxo de Eventos

### Fluxo: Expiração de Reserva

```
┌─────────────────────────────────────────────────────────────────┐
│ SCHEDULER APP                                                   │
└─────────────────────────────────────────────────────────────────┘

ExpireReservationsUseCase.tick() [Cron: */5 * * * *]
  │
  ├─ Busca orders com reservas expiradas
  │
  ├─ Para cada order expirada:
  │  ├─ Libera stock (transaction)
  │  ├─ Cancela order
  │  └─ Incrementa métrica reservations.expired
  │
  └─ Despacha evento:
      └─ eventBus.dispatch({
          kind: 'ORDER_RESERVATION_EXPIRED',
          data: { orderId: '123...' },
          meta: { correlationId, traceId, timestamp }
        })
         │
         └─ ReservationExpiredHandler.handle(event)
             ├─ Libera stock novamente (via handler)
             ├─ Cancela order (redundante, mas safe)
             └─ Incrementa métrica

          ├─ Publica no Kafka: eventBus.publish(event)
          │   └─ Topic: order.events (Kafka)
          │
          └─ Envia para DLQ se falhar
              └─ Topic: order.events.dlq


┌─────────────────────────────────────────────────────────────────┐
│ CONSUMER APP                                                    │
└─────────────────────────────────────────────────────────────────┘

Kafka Topic: order.events
  │
  └─ ProcessOrderEventUseCase.handle(payload, source)
      │
      ├─ Normaliza payload com normalizeOrderEvent()
      │
      ├─ Valida evento
      │  └─ Se inválido: envia para DLQ
      │
      └─ Despacha no EventBus:
          └─ eventBus.dispatch(event)
              │
              └─ ReservationExpiredHandler.handle(event)
                  ├─ Processa reserva expirada
                  └─ Libera stock + cancela order
```

### Fluxo: Checkout Iniciado → Ordem Ativada

```
┌─────────────────────────────────────────────────────────────────┐
│ HTTP APP                                                        │
└─────────────────────────────────────────────────────────────────┘

CheckoutUseCase.execute()
  │
  └─ Emite evento:
      └─ eventBus.dispatch({
          kind: 'ORDER_CHECKOUT_INITIATED',
          data: { order_id, ... },
          meta: { correlationId, traceId, ... }
        })
       │
       └─ CheckoutInitiatedHandler.execute(event)
           └─ ActiveOrderUseCase.execute(event)


OnlineActivationStrategy.execute()
  │
  ├─ Executa steps de ativação
  │  ├─ ConsumeStockReservationStep
  │  ├─ ActivateContractStep
  │  └─ ...
  │
  └─ Emite evento ao final:
      └─ eventBus.dispatch({
          kind: 'order.activated',
          data: { orderId },
          meta: { correlationId, traceId, parentSpanId, timestamp }
        })
         │
         └─ OrderActivatedHandler.handle(event)
             ├─ Verifica se order existe
             └─ Incrementa métrica reservations.activated
```

---

## 8. Como Adicionar Novo Tipo de Evento

### Passo 1: Definir o Tipo de Evento

**Arquivo**: `libs/order/src/domain/events/order.event.ts`

```typescript
// Adicionar novo tipo
export type YourCustomEvent = OrderEvent<{
  yourField: string;
  anotherField: number;
}>;
```

### Passo 2: Criar o Handler

**Arquivo**: `libs/order/src/adapters/handlers/your-custom.handler.ts`

```typescript
import { Injectable } from '@nestjs/common';
import { OrderEvent } from '@app/order/domain/events';
import { EventHandler } from './event.handler';

@Injectable()
export class YourCustomHandler implements EventHandler<{ yourField: string }> {
  kind = 'your.event.kind'; // Use um identificador único

  constructor(
    private readonly logger: AppLogger,
    // Injete dependências necessárias
  ) {}

  async handle(event: OrderEvent<{ yourField: string }>): Promise<void> {
    const { yourField } = event.data;
    const { correlationId } = event.meta;

    this.logger.info('your.event.processing', { yourField, correlationId });

    // Implemente sua lógica aqui
    // Use transações quando necessário
    // Capture métricas
  }
}
```

### Passo 3: Registrar o Handler no Registry

**Arquivo**: `libs/order/src/adapters/handlers/handlers.registry.ts`

```typescript
export class HandlersRegistry {
  constructor(
    // ... existing handlers
    private readonly yourCustomHandler: YourCustomHandler, // Injetar
  ) {}

  registerAll(eventBus: EventBus): void {
    const handlers = [
      // ... existing handlers
      this.yourCustomHandler, // Adicionar aqui
    ];

    handlers.forEach((handler) => {
      eventBus.register(handler as any);
    });
  }
}
```

### Passo 4: Emitir o Evento

Em qualquer lugar onde você queira emitir o evento:

```typescript
constructor(
  private readonly eventBus: EventBus,
) {}

async execute(): Promise<void> {
  // ... sua lógica ...

  await this.eventBus.dispatch({
    kind: 'your.event.kind',
    data: { yourField: 'value' },
    meta: {
      correlationId: randomUUID(),
      traceId: randomBytes(16).toString('hex'),
      timestamp: Date.now(),
    },
  });

  // Opcionalmente, publicar no Kafka
  await this.eventBus.publish(event);
}
```

### Passo 5: Adicionar Testes

**Arquivo**: `libs/order/src/adapters/handlers/__tests__/your-custom.handler.spec.ts`

```typescript
describe('YourCustomHandler', () => {
  let handler: YourCustomHandler;
  let logger: AppLogger;

  beforeEach(() => {
    logger = mock(AppLogger);
    handler = new YourCustomHandler(logger);
  });

  it('should handle your custom event', async () => {
    const event: OrderEvent = {
      kind: 'your.event.kind',
      data: { yourField: 'test' },
      meta: {
        correlationId: 'corr-123',
        traceId: 'trace-123',
        timestamp: Date.now(),
      },
    };

    await handler.handle(event);

    expect(logger.info).toHaveBeenCalledWith('your.event.processing', expect.any(Object));
  });
});
```

---

## 9. Testing Strategy

### Unit Tests: Handlers
Testa cada handler isoladamente

```bash
npm test -- libs/order/src/adapters/handlers/your-custom.handler.spec.ts
```

### Unit Tests: EventBus
Testa registro e disparo de eventos

```bash
npm test -- libs/order/src/adapters/handlers/event.bus.spec.ts
```

### Integration Tests: Scheduler → Event → Handler
Testa fluxo completo de expiração de reservas

```bash
npm test -- apps/scheduler/src/expire-reservations.integration.spec.ts
```

### Integration Tests: Checkout → Activation → Event
Testa fluxo de ativação de order

```bash
npm test -- libs/order/src/activation/online-activation.integration.spec.ts
```

### E2E Tests: Full Flow
Testa com apps rodando:

```bash
docker-compose up -d
npm run test:e2e
```

---

## 10. Referências

### Arquivos Principais

| Arquivo | Responsabilidade |
|---------|-----------------|
| `libs/order/src/domain/events/order.event.ts` | Definições de tipos de eventos |
| `libs/order/src/adapters/handlers/event.bus.ts` | Orquestrador central pub/sub |
| `libs/order/src/adapters/handlers/event.handler.ts` | Interface para handlers |
| `libs/order/src/adapters/handlers/handlers.registry.ts` | Registro e inicialização |
| `libs/order/src/adapters/handlers/order-activated.handler.ts` | Handler de ativação |
| `libs/order/src/adapters/usecases/process-order-event.use-case.ts` | Consumidor Kafka |
| `libs/order/src/adapters/usecases/expire-reservations.use-case.ts` | Scheduler cron |
| `libs/order/src/adapters/usecases/event-handlers/checkout-initiated.handler.ts` | Handler de checkout |
| `libs/order/src/adapters/usecases/event-handlers/reservation-expired.handler.ts` | Handler de expiração |
| `libs/order/src/activation/strategies/online-activation.strategy.ts` | Estratégia de ativação |

### Configuração Kafka

```env
# Consumer App
KAFKA_BROKERS=localhost:9092
KAFKA_GROUP_ID=order-consumer
KAFKA_ORDER_TOPIC=order.events
CHECKOUT_TOPIC=order.checkout
```

### Módulo NestJS

O EventBus é declarado como provider no módulo de Order:

```typescript
@Module({
  providers: [
    EventBus,
    HandlersRegistry,
    CheckoutInitiatedHandler,
    ReservationExpiredHandler,
    OrderActivatedHandler,
    ProcessOrderEventUseCase,
    ExpireReservationsUseCase,
    // ...
  ],
})
export class OrderModule {}
```

---

## 11. Boas Práticas

### ✅ Do's
- **Use metadados de correlação** para rastreamento distribuído
- **Implemente transações** para operações críticas (stock, status de order)
- **Log e métricas** em cada handler para observabilidade
- **Trate erros gracefully** - não propague erro entre handlers
- **Documente o payload** de cada tipo de evento
- **Versione eventos** quando schema mudar (adicionar schema_version)

### ❌ Don'ts
- **Não acople handlers** - cada handler é independente
- **Não coloque lógica pesada** no dispatch - use workers se necessário
- **Não ignore erros** - sempre log e capture em métrica
- **Não deixe eventos sem handler** - vai se acumular com warning
- **Não use timestamp do sistema** em meta.timestamp - use fornecido ou Date.now()

---

## 12. Troubleshooting

### Evento não está sendo processado

1. Verificar se handler está registrado no `HandlersRegistry`
2. Verificar se `kind` do evento corresponde com `kind` do handler
3. Checar logs do consumer app para mensagens de erro
4. Verificar se evento caiu no DLQ (dead-letter queue)

```bash
npm run logs -- apps/consumer
```

### Múltiplos handlers para mesmo evento tipo

O EventBus suporta múltiplos handlers para o mesmo `kind` e os executa em paralelo.

```typescript
// Ambos vão ser chamados
const event = { kind: 'order.activated', ... };
await eventBus.dispatch(event); // Chama ambos handlers em paralelo
```

### Evento com correlationId replicado

Use `randomUUID()` para gerar um novo `correlationId` para cada evento.

### Performance degradada

- Verificar tamanho das transações - quebrar em operações menores
- Verificar se handlers estão fazendo muitas queries
- Usar índices de banco para queries críticas

---

## 13. Roadmap Futuro

- [ ] Circuit breaker para handlers falhando
- [ ] Dead letter queue com replay automático
- [ ] Saga distribuída para operações multi-step
- [ ] Event sourcing para auditoria completa
- [ ] Schema registry para validação de eventos
- [ ] Event replay para debugging

