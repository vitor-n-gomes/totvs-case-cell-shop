import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiHeader,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { PublishMessage } from '@app/demo/use-cases/publish-message';
import { GetReceipt } from '@app/demo/use-cases/get-receipt';
import { AppLogger } from '@app/platform/logging/app-logger';
import {
  ErrorResponseDto,
  MessageReceiptDto,
  PublishedMessageDto,
  PublishMessageDto,
} from './message.dto';

@ApiTags('Demo')
@ApiHeader({
  name: 'x-correlation-id',
  required: false,
  description: 'UUID; generated when absent or invalid',
})
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiInternalServerErrorResponse({ type: ErrorResponseDto })
@Controller('demo/messages')
export class DemoController {
  constructor(
    private readonly publish: PublishMessage,
    private readonly getReceipt: GetReceipt,
    private readonly logger: AppLogger,
  ) {}

  @Post()
  @HttpCode(202)
  @ApiAcceptedResponse({
    type: PublishedMessageDto,
    description:
      'Kafka acknowledged publication; receipt processing is asynchronous',
  })
  @ApiServiceUnavailableResponse({ type: ErrorResponseDto })
  async create(
    @Body() body: PublishMessageDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PublishedMessageDto> {
    const correlationId = response.locals.correlationId as string;
    try {
      const result = await this.publish.execute(body.message, correlationId);
      this.logger.info('demo.message.published', {
        correlationId,
        eventId: result.eventId,
      });
      return result;
    } catch {
      this.logger.info('demo.message.publication.failed', { correlationId });
      throw new ServiceUnavailableException(
        'Message publication could not be confirmed',
      );
    }
  }

  @Get(':eventId')
  @ApiOkResponse({ type: MessageReceiptDto })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'No receipt yet; retry after asynchronous consumption',
  })
  async find(
    @Param('eventId', new ParseUUIDPipe()) eventId: string,
  ): Promise<MessageReceiptDto> {
    const receipt = await this.getReceipt.execute(eventId);
    if (!receipt)
      throw new NotFoundException(
        'Receipt not found; processing may still be pending',
      );
    return receipt;
  }
}
