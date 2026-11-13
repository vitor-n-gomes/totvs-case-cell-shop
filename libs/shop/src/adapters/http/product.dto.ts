import { ApiProperty } from '@nestjs/swagger';
export class ProductDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty() productKey: string;
  @ApiProperty({ example: '29.90', pattern: '^\\d+\\.\\d{2}$' })
  netPrice: number;
  @ApiProperty({ example: '39.90', pattern: '^\\d+\\.\\d{2}$' })
  listPrice: number;
}
