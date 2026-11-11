import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProductEntity } from '../entities';

@Injectable()
export class ProductRepository {
  constructor(private readonly database: DataSource) {}
  findAll(): Promise<ProductEntity[]> {
    return this.database
      .getRepository(ProductEntity)
      .find({ order: { productKey: 'ASC' } });
  }
}
