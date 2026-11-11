import { Module } from '@nestjs/common';
import { LoggingModule } from '../logging/logging.module';
import { Metrics, MetricsController } from './metrics';
import { Spans } from './spans';

@Module({
  imports: [LoggingModule],
  controllers: [MetricsController],
  providers: [Metrics, Spans],
  exports: [Metrics, Spans],
})
export class ObservabilityModule {}
