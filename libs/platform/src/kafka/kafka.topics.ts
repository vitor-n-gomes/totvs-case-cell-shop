// Logical patterns are bound to validated topic names when each Nest server starts.
export const ORDER_EVENT_PATTERN = 'order.checkout.initiated';
export const ORDER_KAFKA_TRANSPORT = Symbol('orders-kafka');
export const KAFKA_CLIENT = 'case_cell_client';
