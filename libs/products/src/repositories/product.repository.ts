import { Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { ProductEntity } from '../domain/entities';

@Injectable()
export class ProductRepository {
  constructor(
    @InjectRepository(ProductEntity)
    private readonly products: Repository<ProductEntity>,
  ) {}

  findAll(): Promise<ProductEntity[]> {
    return this.products
      .createQueryBuilder('product')
      .innerJoin('product.stock', 'stock')
      .where('stock.physical_quantity - stock.reserved_quantity >= :minimum', {
        minimum: 1,
      })
      .orderBy('product.productKey', 'ASC')
      .getMany();
  }
}
