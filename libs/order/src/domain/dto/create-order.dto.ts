import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
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
  Environment,
  OrderStatus,
  PaymentType,
  ProcessingStatus,
} from '@app/contracts';

export class CheckoutItemDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() productId: string;
  @ApiProperty({ minimum: 1, maximum: 1000000 })
  @IsInt()
  @Min(1)
  @Max(1000000)
  quantity: number;
}
export class CheckoutDto {
  @ApiProperty({ enum: PaymentType })
  @IsEnum(PaymentType)
  paymentType: PaymentType;
  @ApiProperty({ format: 'date', example: '2026-11-10' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  dueDate: string;
  @ApiProperty({ maxLength: 254 })
  @IsString()
  @Matches(/\S/)
  @MaxLength(254)
  mainContact: string;
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
  paymentMethod: string;
  @ApiProperty({ enum: Environment })
  @IsEnum(Environment)
  environment: Environment;
  @ApiProperty({ type: [CheckoutItemDto], minItems: 1, maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CheckoutItemDto)
  items: CheckoutItemDto[];
}
export class CheckoutAcceptedDto {
  @ApiProperty({ format: 'uuid' }) orderId: string;
  @ApiProperty({ enum: [OrderStatus.Pending] }) status: OrderStatus.Pending;
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
  @ApiProperty() paymentMethod: string;
  @ApiProperty({ format: 'date' }) dueDate: string;
  @ApiProperty({ enum: Environment })
  environment: Environment;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
  @ApiProperty({ type: [OrderItemDto] }) items: OrderItemDto[];
}
