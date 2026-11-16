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
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CheckoutUseCase } from '../usecases/checkout.use-case';
import { GetOrderStatusUseCase } from '../usecases/get-order-status.use-case';
import { ErrorResponseDto } from '@app/platform/http/error-response.dto';
import {
  CheckoutAcceptedDto,
  CheckoutDto,
  OrderStatusDto,
} from '@app/order/domain/dto/create-order.dto';

@ApiTags('storefront')
@ApiHeader({
  name: 'x-correlation-id',
  required: false,
  schema: { type: 'string', format: 'uuid' },
})
@ApiServiceUnavailableResponse({ type: ErrorResponseDto })
@Controller()
export class OrderController {
  constructor(
    private readonly checkoutUseCase: CheckoutUseCase,
    private readonly getOrderStatusUseCase: GetOrderStatusUseCase,
  ) {}

  @Post('checkout')
  @ApiOperation({ operationId: 'ShopController_create' })
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
    @Body() checkoutDto: CheckoutDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CheckoutAcceptedDto> {
    return this.checkoutUseCase.execute(
      checkoutDto,
      idempotencyKey,
      String(response.locals.correlationId),
    );
  }

  @Get('orders/:orderId/status')
  @ApiOperation({ operationId: 'ShopController_status' })
  @ApiOkResponse({ type: OrderStatusDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  status(
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ): Promise<OrderStatusDto> {
    return this.getOrderStatusUseCase.execute(orderId);
  }
}
