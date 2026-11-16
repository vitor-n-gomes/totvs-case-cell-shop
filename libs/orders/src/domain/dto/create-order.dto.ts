import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Environment,
  OrderStatus,
  PaymentType,
  ProcessingStatus,
} from '../shared/types/order.type';

export const checkoutItemSchema = z.strictObject({
  productId: z.uuid(),
  quantity: z.number().int().min(1).max(1000000),
});

const contactSchema = z.string().max(254).regex(/\S/);

export const checkoutSchema = z.strictObject({
  paymentType: z.enum(PaymentType),
  dueDate: z.iso.date(),
  mainContact: contactSchema,
  altContact: contactSchema
    .nullable()
    .transform((value) => value ?? undefined)
    .optional(),
  paymentMethod: z.string().max(100).regex(/\S/),
  environment: z.enum(Environment),
  items: z.array(checkoutItemSchema).min(1).max(100),
});

export class CheckoutItemDto implements z.infer<typeof checkoutItemSchema> {
  @ApiProperty({ format: 'uuid' })
  productId: string;

  @ApiProperty({ minimum: 1, maximum: 1000000 })
  quantity: number;
}

export class CheckoutDto implements z.infer<typeof checkoutSchema> {
  static readonly schema = checkoutSchema;

  @ApiProperty({ enum: PaymentType })
  paymentType: PaymentType;

  @ApiProperty({ format: 'date', example: '2026-11-10' })
  dueDate: string;

  @ApiProperty({ maxLength: 254 })
  mainContact: string;

  @ApiPropertyOptional({ maxLength: 254 })
  altContact?: string;

  @ApiProperty({ maxLength: 100 })
  paymentMethod: string;

  @ApiProperty({ enum: Environment })
  environment: Environment;

  @ApiProperty({ type: [CheckoutItemDto], minItems: 1, maxItems: 100 })
  items: CheckoutItemDto[];
}

export class CheckoutAcceptedDto {
  @ApiProperty({ format: 'uuid' })
  orderId: string;

  @ApiProperty({ enum: [OrderStatus.Pending] })
  status: OrderStatus.Pending;
}

export class OrderItemDto extends CheckoutItemDto {
  @ApiProperty({ example: 2990 })
  netPrice: number;

  @ApiProperty({ example: 3990 })
  listPrice: number;
}

export class OrderStatusDto {
  @ApiProperty({ format: 'uuid' })
  orderId: string;

  @ApiProperty({ enum: OrderStatus })
  status: OrderStatus;

  @ApiProperty({ enum: ProcessingStatus })
  processingStatus: ProcessingStatus;

  @ApiProperty({ enum: PaymentType })
  paymentType: PaymentType;

  @ApiProperty()
  paymentMethod: string;

  @ApiProperty({ format: 'date' })
  dueDate: string;

  @ApiProperty({ enum: Environment })
  environment: Environment;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: [OrderItemDto] })
  items: OrderItemDto[];
}
