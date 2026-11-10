import { z } from 'zod';
import { DEMO_MESSAGE_TOPIC } from '@app/contracts';

const port = z.coerce.number().int().min(1).max(65535);

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    API_PORT: port.default(3000),
    WORKER_PORT: port.default(3001),
    DATABASE_URL: z
      .string()
      .url()
      .refine(
        (value) => /^postgres(?:ql)?:/.test(value),
        'Expected a PostgreSQL URL',
      ),
    REDIS_URL: z
      .string()
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
    KAFKA_TOPIC: z
      .string()
      .regex(/^[a-zA-Z0-9._-]+$/)
      .default(DEMO_MESSAGE_TOPIC),
    KAFKA_GROUP_ID: z.string().min(1).default('casecellshop-demo-worker'),
  })
  .superRefine((value, context) => {
    if (value.API_PORT === value.WORKER_PORT) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
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
