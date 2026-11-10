import { messageCreatedSchema } from '@app/contracts';
import { validateEnvironment } from '@app/platform/config/environment';
import { event } from './fixtures';

describe('Event contract', () => {
  it('accepts a versioned event and preserves its correlation ID', () => {
    const input = event();
    expect(messageCreatedSchema.parse(input)).toEqual(input);
  });
  it.each([
    { schemaVersion: 2 },
    { eventId: 'invalid' },
    { occurredAt: 'yesterday' },
    { message: '\n\t' },
    { message: 'a'.repeat(501) },
    { unexpected: true },
  ])('rejects incompatible data: %j', (change) => {
    expect(
      messageCreatedSchema.safeParse({ ...event(), ...change }).success,
    ).toBe(false);
  });
});

describe('Configuration', () => {
  const valid = {
    DATABASE_URL: 'postgresql://user:secret@localhost:5432/casecellshop_test',
    REDIS_URL: 'redis://localhost:6379/1',
    KAFKA_BROKERS: 'localhost:9092, kafka:19092',
  };
  it('parses broker lists and applies documented defaults', () => {
    expect(validateEnvironment(valid)).toMatchObject({
      API_PORT: 3000,
      WORKER_PORT: 3001,
      KAFKA_BROKERS: ['localhost:9092', 'kafka:19092'],
    });
  });
  it.each([
    { DATABASE_URL: undefined },
    { DATABASE_URL: 'mysql://localhost/store' },
    { REDIS_URL: 'http://localhost' },
    { KAFKA_BROKERS: 'localhost' },
    { API_PORT: 'NaN' },
    { WORKER_PORT: 3000 },
  ])('fails fast for invalid configuration: %j', (change) => {
    expect(() => validateEnvironment({ ...valid, ...change })).toThrow(
      'Invalid configuration',
    );
  });
  it('does not include database credentials in validation errors', () => {
    try {
      validateEnvironment({ ...valid, DATABASE_URL: 'secret-password' });
    } catch (error) {
      expect(String(error)).not.toContain('secret-password');
    }
  });
});
