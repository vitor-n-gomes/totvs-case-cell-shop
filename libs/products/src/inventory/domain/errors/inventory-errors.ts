export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class ReservationExpiredError extends InventoryError {}
