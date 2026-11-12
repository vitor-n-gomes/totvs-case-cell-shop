import { Controller, Get } from '@nestjs/common';
import {
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '@app/platform/http/error-response.dto';
import { GetProducts } from '../../catalog/get-products';
import { ProductDto } from './product.dto';
@ApiTags('storefront')
@ApiHeader({
  name: 'x-correlation-id',
  required: false,
  schema: { type: 'string', format: 'uuid' },
})
@ApiServiceUnavailableResponse({ type: ErrorResponseDto })
@Controller()
export class CatalogController {
  constructor(private readonly products: GetProducts) {}
  @Get('products')
  @ApiOperation({ operationId: 'ShopController_getProducts' })
  @ApiOkResponse({ type: [ProductDto] })
  getProducts(): Promise<ProductDto[]> {
    return this.products.execute();
  }
}
