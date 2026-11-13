import { ApiProperty } from '@nestjs/swagger';
export class ProductDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  productKey: string;

  @ApiProperty({ example: 2990 })
  netPrice: number;

  @ApiProperty({ example: 3990 })
  listPrice: number;
}
