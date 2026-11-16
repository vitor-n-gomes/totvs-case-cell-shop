import { validateEnvironment } from '@app/platform/config/environment';

const baseEnvironment = {
  DATABASE_URL: 'postgresql://user:password@localhost:5432/shop',
  REDIS_URL: 'redis://localhost:6379',
  KAFKA_BROKERS: 'localhost:9092',
};

describe('validateEnvironment', () => {
  it('applies defaults and ignores unrelated process variables', () => {
    expect(
      validateEnvironment({ ...baseEnvironment, UNRELATED: 'value' }),
    ).toMatchObject({
      CHECKOUT_TOPIC: 'order.checkout.initiated',
      RESERVATION_TTL_SECONDS: 900,
      API_PORT: 3000,
      WORKER_PORT: 3001,
      KAFKA_SSL: false,
      KAFKA_BROKERS: ['localhost:9092'],
      NODE_ENV: 'development',
    });

    expect(validateEnvironment(baseEnvironment)).not.toHaveProperty(
      'UNRELATED',
    );
  });

  it('coerces numeric values and trims broker entries', () => {
    expect(
      validateEnvironment({
        ...baseEnvironment,
        API_PORT: '65535',
        WORKER_PORT: '1',
        KAFKA_SSL: 'true',
        KAFKA_BROKERS: 'one:9092, two:9093',
        RESERVATION_TTL_SECONDS: '86400',
      }),
    ).toMatchObject({
      API_PORT: 65535,
      WORKER_PORT: 1,
      KAFKA_SSL: true,
      KAFKA_BROKERS: ['one:9092', 'two:9093'],
      RESERVATION_TTL_SECONDS: 86400,
    });
  });

  it.each([
    ['API_PORT', 0],
    ['API_PORT', 65536],
    ['API_PORT', 3000.5],
    ['API_PORT', 'abc'],
    ['RESERVATION_TTL_SECONDS', 0],
    ['RESERVATION_TTL_SECONDS', 86401],
    ['SCHEDULER_INTERVAL_MS', 99],
    ['SCHEDULER_INTERVAL_MS', 3600001],
    ['SIMULATOR_DELAY_MS', -1],
    ['SIMULATOR_DELAY_MS', 10001],
    ['SIMULATOR_TIMEOUT_MS', 0],
    ['ERP_FAILURES', 6],
    ['EMAIL_FAILURES', -1],
    ['KAFKA_SSL', true],
    ['KAFKA_SSL', 'yes'],
    ['NODE_ENV', 'staging'],
    ['DATABASE_URL', 'https://localhost/db'],
    ['REDIS_URL', 'postgresql://localhost/db'],
    ['KAFKA_BROKERS', 'localhost'],
    ['KAFKA_BROKERS', 'localhost:9092,'],
    ['CHECKOUT_TOPIC', 'has space'],
    ['KAFKA_TOPIC', 'bad/topic'],
  ])('rejects invalid %s = %p', (key, value) => {
    expect(() =>
      validateEnvironment({ ...baseEnvironment, [key]: value }),
    ).toThrow(key);
  });

  it('requires distinct HTTP and worker ports', () => {
    expect(() =>
      validateEnvironment({
        ...baseEnvironment,
        API_PORT: 3000,
        WORKER_PORT: 3000,
      }),
    ).toThrow('App ports must differ');
  });

  it.each([
    'KAFKA_SASL_MECHANISM',
    'KAFKA_SASL_USERNAME',
    'KAFKA_SASL_PASSWORD',
  ])('requires the remaining SASL fields when only %s is present', (field) => {
    expect(() =>
      validateEnvironment({
        ...baseEnvironment,
        [field]: field === 'KAFKA_SASL_MECHANISM' ? 'plain' : 'credential',
      }),
    ).toThrow('Required for Kafka SASL authentication');
  });

  it.each(['plain', 'scram-sha-256', 'scram-sha-512'])(
    'accepts a complete %s SASL configuration',
    (mechanism) => {
      expect(
        validateEnvironment({
          ...baseEnvironment,
          KAFKA_SASL_MECHANISM: mechanism,
          KAFKA_SASL_USERNAME: 'user',
          KAFKA_SASL_PASSWORD: 'secret',
        }).KAFKA_SASL_MECHANISM,
      ).toBe(mechanism);
    },
  );

  it('does not include credential values in validation errors', () => {
    const secret = 'private-password-for-test';

    expect(() =>
      validateEnvironment({
        ...baseEnvironment,
        DATABASE_URL: `https://user:${secret}@localhost/shop`,
        KAFKA_SASL_PASSWORD: secret,
      }),
    ).toThrow('Invalid configuration');

    expect(() =>
      validateEnvironment({
        ...baseEnvironment,
        DATABASE_URL: `https://user:${secret}@localhost/shop`,
        KAFKA_SASL_PASSWORD: secret,
      }),
    ).not.toThrow(secret);
  });
});
