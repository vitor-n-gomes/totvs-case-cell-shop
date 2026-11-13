import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';
import { z } from 'zod';

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const dto = metadata.metatype as { schema?: z.ZodType } | undefined;
    if (!dto?.schema) return value;

    const result = dto.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(
        result.error.issues.map(
          (issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`,
        ),
      );
    }
    return result.data;
  }
}
