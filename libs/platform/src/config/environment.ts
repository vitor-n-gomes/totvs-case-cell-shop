import { z } from 'zod';
import { ORDER_EVENT_PATTERN } from '../kafka/kafka.topics';

const port = z.coerce.number().int().min(1).max(65535);

const environmentSchema = z
  .object({
    CHECKOUT_TOPIC: z
      .string()
      .regex(/^[a-zA-Z0-9._-]+$/)
      .default('order.checkout.initiated'),
    RESERVATION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(86400)
      .default(900),
    SCHEDULER_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(3_600_000)
      .default(10000),
    SIMULATOR_DELAY_MS: z.coerce.number().int().min(0).max(10000).default(20),
    SIMULATOR_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(1000),
    ERP_FAILURES: z.coerce.number().int().min(0).max(5).default(0),
    EMAIL_FAILURES: z.coerce.number().int().min(0).max(5).default(0),
    SIMULATOR_PERMANENT_FAILURE: z
      .enum(['none', 'erp', 'email'])
      .default('none'),
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    API_PORT: port.default(3000),
    WORKER_PORT: port.default(3001),
    DATABASE_URL: z
      .url()
      .refine(
        (value) => /^postgres(?:ql)?:/.test(value),
        'Expected a PostgreSQL URL',
      ),
    REDIS_URL: z
      .url()
      .refine((value) => /^rediss?:/.test(value), 'Expected a Redis URL'),
    KAFKA_BROKERS: z
      .string()
      .min(1)
      .transform((value) => value.split(',').map((broker) => broker.trim()))
      .pipe(
        z
          .array(z.string().regex(/^[^\s:,]+:\d+$/, 'Expected host:port'))
          .min(1),
      ),
    KAFKA_SSL: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    KAFKA_SASL_MECHANISM: z
      .enum(['plain', 'scram-sha-256', 'scram-sha-512'])
      .optional(),
    KAFKA_SASL_USERNAME: z.string().min(1).optional(),
    KAFKA_SASL_PASSWORD: z.string().min(1).optional(),
    KAFKA_TOPIC: z
      .string()
      .regex(/^[a-zA-Z0-9._-]+$/)
      .default(ORDER_EVENT_PATTERN),
    KAFKA_GROUP_ID: z.string().min(1).default('casecellshop-demo-worker'),
  })
  .superRefine((value, context) => {
    if (
      value.KAFKA_SASL_MECHANISM ||
      value.KAFKA_SASL_USERNAME ||
      value.KAFKA_SASL_PASSWORD
    ) {
      for (const key of [
        'KAFKA_SASL_MECHANISM',
        'KAFKA_SASL_USERNAME',
        'KAFKA_SASL_PASSWORD',
      ] as const) {
        if (!value[key])
          context.addIssue({
            code: 'custom',
            path: [key],
            message: 'Required for Kafka SASL authentication',
          });
      }
    }
    if (value.API_PORT === value.WORKER_PORT) {
      context.addIssue({
        code: 'custom',
        path: ['WORKER_PORT'],
        message: 'App ports must differ',
      });
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(
  input: Record<string, unknown>,
): Environment {
  const result = environmentSchema.safeParse(input);
  if (!result.success) {
    // Validation errors describe keys and constraints, never credential values.
    throw new Error(
      `Invalid configuration: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
  }
  return result.data;
}
