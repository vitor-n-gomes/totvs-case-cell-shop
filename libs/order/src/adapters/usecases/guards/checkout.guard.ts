import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CheckoutInput } from '@app/order/domain/dto/create-order.dto';

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,128}$/;

@Injectable()
export class CheckoutGuard {
  validate(
    checkoutInput: CheckoutInput,
    idempotencyKey: string | undefined,
  ): asserts idempotencyKey is string {
    if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {

      throw new BadRequestException(
        'Idempotency-Key must contain 1-128 visible ASCII characters',
      );

    }

    const uniqueProductIds = new Set(
      checkoutInput.items.map((checkoutItem) => checkoutItem.productId),
    );

    if (uniqueProductIds.size !== checkoutInput.items.length) {

      throw new BadRequestException('Duplicate products are not allowed');

    }
  }

  hashPayload(checkoutInput: CheckoutInput): string {
    const normalizedPayload = {
      paymentType: checkoutInput.paymentType,
      dueDate: checkoutInput.dueDate,
      mainContact: checkoutInput.mainContact,
      altContact: checkoutInput.altContact ?? null,
      paymentMethod: checkoutInput.paymentMethod,
      environment: checkoutInput.environment,
      items: [...checkoutInput.items]
        .sort((leftItem, rightItem) =>
          leftItem.productId.localeCompare(rightItem.productId),
        )
        .map(({ productId, quantity }) => ({ productId, quantity })),
    };

    return createHash('sha256')
      .update(JSON.stringify(normalizedPayload))
      .digest('hex');
  }
}
