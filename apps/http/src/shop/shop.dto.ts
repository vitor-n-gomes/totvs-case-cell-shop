import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
  IsDateString,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ENVIRONMENTS,
  ORDER_STATUSES,
  PAYMENT_TYPES,
  PROCESSING_STATUSES,
} from '@app/contracts';

export class CheckoutItemDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() productId!: string;
  @ApiProperty({ minimum: 1, maximum: 1000000 })
  @IsInt()
  @Min(1)
  @Max(1000000)
  quantity!: number;
}
export class CheckoutDto {
  @ApiProperty({ enum: PAYMENT_TYPES })
  @IsIn(PAYMENT_TYPES)
  paymentType!: (typeof PAYMENT_TYPES)[number];
  @ApiProperty({ format: 'date', example: '2026-11-10' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  dueDate!: string;
  @ApiProperty({ maxLength: 254 })
  @IsString()
  @Matches(/\S/)
  @MaxLength(254)
  mainContact!: string;
  @ApiPropertyOptional({ maxLength: 254 })
  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(254)
  altContact?: string;
  @ApiProperty({ maxLength: 100 })
  @IsString()
  @Matches(/\S/)
  @MaxLength(100)
  paymentMethod!: string;
  @ApiProperty({ enum: ENVIRONMENTS })
  @IsIn(ENVIRONMENTS)
  environment!: (typeof ENVIRONMENTS)[number];
  @ApiProperty({ type: [CheckoutItemDto], minItems: 1, maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CheckoutItemDto)
  items!: CheckoutItemDto[];
}
export class ProductDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() productKey!: string;
  @ApiProperty({ example: '29.90', pattern: '^\\d+\\.\\d{2}$' })
  netPrice!: string;
  @ApiProperty({ example: '39.90', pattern: '^\\d+\\.\\d{2}$' })
  listPrice!: string;
}
export class CheckoutAcceptedDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ enum: ['PENDING'] }) status!: 'PENDING';
}
export class OrderItemDto extends CheckoutItemDto {
  @ApiProperty({ example: '29.90' }) netPrice!: string;
  @ApiProperty({ example: '39.90' }) listPrice!: string;
}
export class OrderStatusDto {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ enum: ORDER_STATUSES })
  status!: (typeof ORDER_STATUSES)[number];
  @ApiProperty({ enum: PROCESSING_STATUSES })
  processingStatus!: (typeof PROCESSING_STATUSES)[number];
  @ApiProperty({ enum: PAYMENT_TYPES })
  paymentType!: (typeof PAYMENT_TYPES)[number];
  @ApiProperty() paymentMethod!: string;
  @ApiProperty({ format: 'date' }) dueDate!: string;
  @ApiProperty({ enum: ENVIRONMENTS })
  environment!: (typeof ENVIRONMENTS)[number];
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: [OrderItemDto] }) items!: OrderItemDto[];
}
