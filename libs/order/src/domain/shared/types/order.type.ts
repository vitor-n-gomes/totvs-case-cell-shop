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

export enum ProcessingStatus {
  Pending = 'Pending',
  Processing = 'Processing',
  Retrying = 'Retrying',
  Completed = 'Completed',
  Failed = 'Failed',
}
