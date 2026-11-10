import { Controller, Get, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { HealthService } from './health.service';

@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live') live(): { status: string } {
    return { status: 'up' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const result = await this.health.readiness();
    response.status(result.ready ? 200 : 503);
    return result;
  }

  @Get('cache') cache() {
    return this.health.cacheStatus();
  }
}
