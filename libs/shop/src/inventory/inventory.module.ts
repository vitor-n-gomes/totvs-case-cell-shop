import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductEntity, StockEntity, ReservationEntity } from '../entities';
import { StockRepository } from './stock.repository';
import { ReservationRepository } from './reservation.repository';
@Module({
  imports: [
    TypeOrmModule.forFeature([ProductEntity, StockEntity, ReservationEntity]),
  ],
  providers: [StockRepository, ReservationRepository],
  exports: [StockRepository, ReservationRepository],
})
export class InventoryModule {}
