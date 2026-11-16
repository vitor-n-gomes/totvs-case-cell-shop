import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CheckoutInput } from '@app/order/domain/dto/create-order.dto';

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,128}$/;

@Injectable()
export class CheckoutGuard {
  validate(
    input: CheckoutInput,
    idempotencyKey: string | undefined,
  ): asserts idempotencyKey is string {
    if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {

      throw new BadRequestException(
        'Idempotency-Key must contain 1-128 visible ASCII characters',
      );

    }

    const uniqueProducts = new Set(input.items.map((item) => item.productId));

    if (uniqueProducts.size !== input.items.length) {

      throw new BadRequestException('Duplicate products are not allowed');

    }
  }

  hashPayload(input: CheckoutInput): string {
    const normalizedPayload = {
      paymentType: input.paymentType,
      dueDate: input.dueDate,
      mainContact: input.mainContact,
      altContact: input.altContact ?? null,
      paymentMethod: input.paymentMethod,
      environment: input.environment,
      items: [...input.items]
        .sort((a, b) => a.productId.localeCompare(b.productId))
        .map(({ productId, quantity }) => ({ productId, quantity })),
    };

    return createHash('sha256')
      .update(JSON.stringify(normalizedPayload))
      .digest('hex');
  }
}
