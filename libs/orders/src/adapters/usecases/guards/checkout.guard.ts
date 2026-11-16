import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CheckoutDto } from '../../../domain/dto/create-order.dto';

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,128}$/;

@Injectable()
export class CheckoutGuard {
  validate(
    checkoutDto: CheckoutDto,
    idempotencyKey: string | undefined,
  ): asserts idempotencyKey is string {
    if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {

      throw new BadRequestException(
        'Idempotency-Key must contain 1-128 visible ASCII characters',
      );

    }

    const uniqueProductIds = new Set(
      checkoutDto.items.map((checkoutItem) => checkoutItem.productId),
    );

    if (uniqueProductIds.size !== checkoutDto.items.length) {

      throw new BadRequestException('Duplicate products are not allowed');

    }
  }

  hashPayload(checkoutDto: CheckoutDto): string {
    const normalizedPayload = {
      paymentType: checkoutDto.paymentType,
      dueDate: checkoutDto.dueDate,
      mainContact: checkoutDto.mainContact,
      altContact: checkoutDto.altContact ?? null,
      paymentMethod: checkoutDto.paymentMethod,
      environment: checkoutDto.environment,
      items: [...checkoutDto.items]
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
