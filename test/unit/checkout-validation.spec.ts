import { checkoutSchema } from '@app/order/domain/dto/create-order.dto';
import { CheckoutGuard } from '@app/order/adapters/usecases/guards/checkout.guard';
import {
  Environment,
  PaymentType,
} from '@app/order/domain/shared/types/order.type';
import { checkoutPayload } from './support/fixtures';

describe('checkoutSchema boundaries', () => {
  it.each([1, 1000000])('accepts quantity %s', (quantity) => {
    const payload = checkoutPayload();

    payload.items[0]!.quantity = quantity;
    expect(checkoutSchema.safeParse(payload).success).toBe(true);
  });

  it.each([0, -1, 1.5, 1000001, NaN, Infinity, '2', null])(
    'rejects quantity %p',
    (quantity) => {
      const payload = checkoutPayload();

      expect(
        checkoutSchema.safeParse({
          ...payload,
          items: [{ ...payload.items[0], quantity }],
        }).success,
      ).toBe(false);
    },
  );

  it.each([1, 100])('accepts %s items', (count) => {
    const payload = checkoutPayload();

    expect(
      checkoutSchema.safeParse({
        ...payload,
        items: Array.from({ length: count }, () => ({ ...payload.items[0] })),
      }).success,
    ).toBe(true);
  });

  it.each([0, 101])('rejects %s items', (count) => {
    const payload = checkoutPayload();

    expect(
      checkoutSchema.safeParse({
        ...payload,
        items: Array.from({ length: count }, () => ({ ...payload.items[0] })),
      }).success,
    ).toBe(false);
  });

  it.each([
    ['dueDate', '2026-02-29'],
    ['dueDate', '2026-11-16T00:00:00Z'],
    ['mainContact', '   '],
    ['mainContact', 'a'.repeat(255)],
    ['altContact', ''],
    ['altContact', 'a'.repeat(255)],
    ['paymentMethod', '\t'],
    ['paymentMethod', 'a'.repeat(101)],
    ['paymentType', 'invalid'],
    ['environment', 'invalid'],
    ['extra', 'forbidden'],
  ])('rejects invalid field %s = %p', (field, value) => {
    expect(
      checkoutSchema.safeParse({ ...checkoutPayload(), [field]: value })
        .success,
    ).toBe(false);
  });

  it.each([null, undefined])(
    'normalizes optional altContact %p',
    (altContact) => {
      expect(
        checkoutSchema.parse({ ...checkoutPayload(), altContact }).altContact,
      ).toBeUndefined();
    },
  );

  it('accepts maximum string lengths and a valid leap day', () => {
    expect(
      checkoutSchema.safeParse({
        ...checkoutPayload(),
        dueDate: '2028-02-29',
        mainContact: 'a'.repeat(254),
        altContact: 'b'.repeat(254),
        paymentMethod: 'c'.repeat(100),
      }).success,
    ).toBe(true);
  });

  it.each([
    { productId: 'not-a-uuid', quantity: 1 },
    {
      productId: checkoutPayload().items[0]!.productId,
      quantity: 1,
      extra: true,
    },
  ])('rejects malformed items %p', (item) => {
    expect(
      checkoutSchema.safeParse({ ...checkoutPayload(), items: [item] }).success,
    ).toBe(false);
  });
});

describe('CheckoutGuard boundaries', () => {
  const guard = new CheckoutGuard();

  it.each(['!', '~', 'x'.repeat(128)])(
    'accepts visible ASCII key %p',
    (key) => {
      expect(() => guard.validate(checkoutPayload(), key)).not.toThrow();
    },
  );

  it.each(['key\n', '\tkey', 'ação', '\x7f', 'x'.repeat(129)])(
    'rejects invalid key %p',
    (key) => {
      expect(() => guard.validate(checkoutPayload(), key)).toThrow(
        'Idempotency-Key',
      );
    },
  );

  it.each([
    { paymentType: PaymentType.PostPaid },
    { dueDate: '2026-12-01' },
    { mainContact: 'another@example.test' },
    { altContact: 'alt@example.test' },
    { environment: Environment.Prod },
    { paymentMethod: 'CARD' },
  ])('includes purchase fields in the payload hash: %p', (change) => {
    const payload = checkoutPayload();

    expect(guard.hashPayload({ ...payload, ...change })).not.toBe(
      guard.hashPayload(payload),
    );
  });

  it('does not mutate item order when computing a hash', () => {
    const payload = checkoutPayload();

    payload.items.push({
      productId: '00000000-0000-4000-8000-000000000001',
      quantity: 1,
    });

    const snapshot = structuredClone(payload);

    guard.hashPayload(payload);
    expect(payload).toEqual(snapshot);
  });
});
