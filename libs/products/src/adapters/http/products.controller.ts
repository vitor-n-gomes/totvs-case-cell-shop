import { Controller, Get } from '@nestjs/common';
import {
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '@app/platform/http/error-response.dto';
import { GetProductsUseCase } from '../usecases/get-products.use-case';
import { ProductDto } from '../../domain/dto/product.dto';
@ApiTags('storefront')
@ApiHeader({
  name: 'x-correlation-id',
  required: false,
  schema: { type: 'string', format: 'uuid' },
})
@ApiServiceUnavailableResponse({ type: ErrorResponseDto })
@Controller()
export class ProductsController {
  constructor(private readonly products: GetProductsUseCase) {}

  @Get('products')
  @ApiOperation({ operationId: 'ShopController_getProducts' })
  @ApiOkResponse({ type: [ProductDto] })
  getProducts(): Promise<ProductDto[]> {
    return this.products.execute();
  }
}
