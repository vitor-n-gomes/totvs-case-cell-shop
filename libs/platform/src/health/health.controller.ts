import { Controller, Get, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { HealthService } from './health.service';

@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live') live(): { status: string } {
    return { status: 'up' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const readinessResult = await this.healthService.readiness();

    response.status(readinessResult.ready ? 200 : 503);

    return readinessResult;
  }

  @Get('cache') cache() {
    return this.healthService.cacheStatus();
  }
}
