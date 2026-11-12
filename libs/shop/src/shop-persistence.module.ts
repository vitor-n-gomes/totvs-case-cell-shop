import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductEntity } from './entities';
import { ProductRepository } from './catalog/product.repository';
@Module({
  imports: [TypeOrmModule.forFeature([ProductEntity])],
  providers: [ProductRepository],
  exports: [ProductRepository],
})
export class ShopPersistenceModule {}
