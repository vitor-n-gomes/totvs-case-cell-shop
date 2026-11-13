import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { productEntities } from '@app/products/domain/entities';
import { inventoryEntities } from './domain/entities';
import { StockRepository } from './repositories/stock.repository';
import { ReservationRepository } from './repositories/reservation.repository';
@Module({
  imports: [
    TypeOrmModule.forFeature([...productEntities, ...inventoryEntities]),
  ],
  providers: [StockRepository, ReservationRepository],
  exports: [StockRepository, ReservationRepository],
})
export class InventoryModule {}
