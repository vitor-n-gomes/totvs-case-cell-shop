export const STEP_NAMES = [
  'ConsumeStockReservationStep',
  'ActivateOrderStep',
  'UpdateErpStep',
  'EmailNotificationStep',
] as const;
export type StepName = (typeof STEP_NAMES)[number];
export const ACTIVATION_ACTION = 'activate_order';
