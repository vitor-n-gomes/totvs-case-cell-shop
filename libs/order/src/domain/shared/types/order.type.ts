export enum PaymentType {
  PrePaid = 'PrePaid',
  PostPaid = 'PostPaid',
}

export enum Environment {
  Local = 'Local',
  PreProd = 'PreProd',
  Prod = 'Prod',
}

export enum OrderStatus {
  Pending = 'Pending',
  Active = 'Active',
  Cancelled = 'Cancelled',
}

/** Orders whose stock reservation may still be returned to inventory on expiry. */
export const EXPIRABLE_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.Pending,
];

export enum ProcessingStatus {
  Pending = 'Pending',
  Processing = 'Processing',
  Retrying = 'Retrying',
  Completed = 'Completed',
  Failed = 'Failed',
}
