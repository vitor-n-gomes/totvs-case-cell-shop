export class PermanentActivationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}
export class ReservationExpiredError extends PermanentActivationError {}
export class OrderCancelledError extends PermanentActivationError {}
export class IntegrationTimeoutError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IntegrationTimeoutError';
  }
}
