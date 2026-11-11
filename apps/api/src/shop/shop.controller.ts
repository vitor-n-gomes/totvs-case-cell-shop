import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { GetProducts } from '@app/shop/catalog/get-products';
import { Checkout } from '@app/shop/orders/checkout';
import { OrderRepository } from '@app/shop/orders/order.repository';
import { ErrorResponseDto } from '../demo/message.dto';
import {
  CheckoutAcceptedDto,
  CheckoutDto,
  OrderStatusDto,
  ProductDto,
} from './shop.dto';

@ApiTags('storefront')
@ApiHeader({
  name: 'x-correlation-id',
  required: false,
  schema: { type: 'string', format: 'uuid' },
})
@ApiServiceUnavailableResponse({ type: ErrorResponseDto })
@Controller()
export class ShopController {
  constructor(
    private readonly products: GetProducts,
    private readonly checkout: Checkout,
    private readonly orders: OrderRepository,
  ) {}
  @Get('products')
  @ApiOkResponse({ type: [ProductDto] })
  getProducts(): Promise<ProductDto[]> {
    return this.products.execute();
  }
  @Post('checkout')
  @HttpCode(202)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', maxLength: 128 },
  })
  @ApiAcceptedResponse({ type: CheckoutAcceptedDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  create(
    @Body() input: CheckoutDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CheckoutAcceptedDto> {
    return this.checkout.execute(
      input,
      key,
      String(response.locals.correlationId),
    );
  }
  @Get('orders/:orderId/status')
  @ApiOkResponse({ type: OrderStatusDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  status(
    @Param('orderId', new ParseUUIDPipe()) id: string,
  ): Promise<OrderStatusDto> {
    return this.orders.status(id);
  }
}
