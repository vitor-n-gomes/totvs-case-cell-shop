import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { productEntities } from './domain/entities';
import { ProductRepository } from './repositories/product.repository';
@Module({
  imports: [TypeOrmModule.forFeature(productEntities)],
  providers: [ProductRepository],
  exports: [ProductRepository],
})
export class ProductsPersistenceModule {}
