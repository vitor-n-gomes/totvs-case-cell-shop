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
    const dtoType = metadata.metatype as { schema?: z.ZodType } | undefined;

    if (!dtoType?.schema) {

      return value;

    }

    const validationResult = dtoType.schema.safeParse(value);

    if (!validationResult.success) {

      throw new BadRequestException(
        validationResult.error.issues.map(
          (validationIssue) =>
            `${validationIssue.path.join('.') || 'body'}: ${validationIssue.message}`,
        ),
      );

    }

    return validationResult.data;
  }
}
