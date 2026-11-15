type SetOptions = { NX?: boolean; PX?: number; EX?: number };
type EvalOptions = { keys: string[]; arguments: string[] };

interface Entry {
  value: string;
  expiresAt?: number;
}

/**
 * In-memory stand-in for the subset of the node-redis client used by the API.
 * TODO: replace with a real Redis (testcontainers or the local `/1` database
 * from .env.test.example) once the infrastructure is available to the suite.
 */
export class InMemoryRedisClient {
  readonly isReady = true;
  private readonly entries = new Map<string, Entry>();

  withCommandOptions(): this {
    return this;
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.read(key)?.value ?? null);
  }

  set(
    key: string,
    value: string,
    options: SetOptions = {},
  ): Promise<'OK' | null> {
    if (options.NX && this.read(key)) return Promise.resolve(null);
    this.entries.set(key, { value, expiresAt: this.expiry(options) });
    return Promise.resolve('OK');
  }

  // Mirrors the two Lua scripts used by GetProductsUseCase (publish and unlock).
  eval(
    script: string,
    { keys, arguments: args }: EvalOptions,
  ): Promise<number> {
    const [lockKey, targetKey] = keys;
    const [token, payload] = args;
    if (!lockKey || this.read(lockKey)?.value !== token)
      return Promise.resolve(0);
    if (script.includes("redis.call('set'") && targetKey && payload) {
      this.entries.set(targetKey, {
        value: payload,
        expiresAt: Date.now() + 300_000,
      });
    } else if (script.includes("redis.call('del'")) {
      this.entries.delete(lockKey);
    }
    return Promise.resolve(1);
  }

  ttlSeconds(key: string): number | null {
    const expiresAt = this.read(key)?.expiresAt;
    return expiresAt === undefined
      ? null
      : Math.ceil((expiresAt - Date.now()) / 1000);
  }

  has(key: string): boolean {
    return this.read(key) !== undefined;
  }

  private read(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private expiry({ PX, EX }: SetOptions): number | undefined {
    if (PX !== undefined) return Date.now() + PX;
    if (EX !== undefined) return Date.now() + EX * 1000;
    return undefined;
  }
}

export class InMemoryRedisConnection {
  readonly client = new InMemoryRedisClient();
}
