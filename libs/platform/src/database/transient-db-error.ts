const TRANSIENT_DB_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53300', // too_many_connections
  '55P03', // lock_not_available
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isTransientDatabaseFailure(error: unknown): boolean {
  const visitedErrors = new Set<object>();
  let currentError: unknown = error;

  while (isRecord(currentError) && !visitedErrors.has(currentError)) {

    visitedErrors.add(currentError);
    const databaseErrorCode = currentError.code;

    if (
      typeof databaseErrorCode === 'string' &&
      (databaseErrorCode.startsWith('08') ||
        databaseErrorCode.startsWith('53') ||
        TRANSIENT_DB_CODES.has(databaseErrorCode))
    ) {

      return true;

    }

    currentError = currentError.driverError ?? currentError.cause;

  }

  return false;
}
