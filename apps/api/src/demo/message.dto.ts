import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

export class PublishMessageDto {
  @ApiProperty({
    example: 'hello',
    minLength: 1,
    maxLength: 500,
    pattern: '\\S',
  })
  @IsString()
  @Matches(/\S/, { message: 'message must not be blank' })
  @MaxLength(500)
  message!: string;
}

export class PublishedMessageDto {
  @ApiProperty({ format: 'uuid' }) eventId!: string;
  @ApiProperty({ enum: ['published'] }) status!: 'published';
}

export class MessageReceiptDto {
  @ApiProperty({ enum: [1] }) schemaVersion!: 1;
  @ApiProperty({ format: 'uuid' }) eventId!: string;
  @ApiProperty({ format: 'uuid' }) correlationId!: string;
  @ApiProperty({ maxLength: 500 }) message!: string;
  @ApiProperty({ format: 'date-time' }) occurredAt!: string;
  @ApiProperty({ format: 'date-time' }) receivedAt!: string;
}

export class ErrorResponseDto {
  @ApiProperty() statusCode!: number;
  @ApiProperty() error!: string;
  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
  })
  message!: string | string[];
  @ApiProperty({ format: 'uuid' }) correlationId!: string;
}
