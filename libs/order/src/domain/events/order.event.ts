/**
 * Base event types for order domain events
 * Follows generic EventBus pattern with correlation tracking
 */

/**
 * Metadata associated with every order event
 * Tracks correlation and tracing information for distributed systems
 */
export interface OrderEventMeta {
  /**
   * Unique identifier to correlate related events across the system
   */
  correlationId: string;

  /**
   * Trace ID for distributed tracing (e.g., OpenTelemetry)
   */
  traceId: string;

  /**
   * Optional parent span ID for hierarchical tracing
   */
  parentSpanId?: string;

  /**
   * Unix timestamp (milliseconds) when the event was created
   */
  timestamp: number;
}

/**
 * Generic base interface for all order events
 * Provides typed structure with correlation metadata
 *
 * @template T - The specific event data type
 */
export interface OrderEvent<T = any> {
  /**
   * Event type identifier (e.g., "order.activated", "reservation.expired")
   */
  kind: string;

  /**
   * Event-specific payload data
   */
  data: T;

  /**
   * Correlation and tracing metadata
   */
  meta: OrderEventMeta;
}

/**
 * Event emitted when an order is activated
 * Used by ActivationStrategy to process order activation
 */
export type OrderActivatedEvent = OrderEvent<{
  // Placeholder for future implementation
  // Event data structure for order activation will be defined when implementing ActivationStrategy
}>;

/**
 * Event emitted when a reservation expires
 * Used by ExpireReservationsUseCase to handle expired reservations
 */
export type ReservationExpiredEvent = OrderEvent<{
  // Placeholder for future implementation
  // Event data structure for reservation expiration will be defined when implementing ExpireReservationsUseCase
}>;
