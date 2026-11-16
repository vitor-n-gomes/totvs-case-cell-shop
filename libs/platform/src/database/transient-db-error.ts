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
  const seen = new Set<object>();
  let current: unknown = error;

  while (isRecord(current) && !seen.has(current)) {

    seen.add(current);
    const code = current.code;

    if (
      typeof code === 'string' &&
      (code.startsWith('08') ||
        code.startsWith('53') ||
        TRANSIENT_DB_CODES.has(code))
    ) {

      return true;

    }

    current = current.driverError ?? current.cause;

  }

  return false;
}
