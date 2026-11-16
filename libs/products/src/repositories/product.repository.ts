import { Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { ProductEntity } from '../domain/entities';

@Injectable()
export class ProductRepository {
  constructor(
    @InjectRepository(ProductEntity)
    private readonly productTypeOrmRepository: Repository<ProductEntity>,
  ) {}

  findAll(): Promise<ProductEntity[]> {
    return this.productTypeOrmRepository
      .createQueryBuilder('product')
      .innerJoin('product.stock', 'stock')
      .where('stock.physicalQuantity - stock.reservedQuantity >= :minimum', {
        minimum: 1,
      })
      .orderBy('product.productKey', 'ASC')
      .getMany();
  }
}
