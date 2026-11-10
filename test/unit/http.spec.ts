import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DemoController } from '../../apps/api/src/demo/demo.controller';
import {
  configureApi,
  createOpenApiDocument,
} from '../../apps/api/src/configure-api';
import { PublishMessage } from '@app/demo/use-cases/publish-message';
import { GetReceipt } from '@app/demo/use-cases/get-receipt';
import { AppLogger } from '@app/platform/logging/app-logger';
import { CorrelationMiddleware } from '@app/platform/logging/correlation.middleware';
import { event, receipt } from './fixtures';

describe('HTTP contract', () => {
  let app: INestApplication;
  const publish = { execute: jest.fn() };
  const getReceipt = { execute: jest.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [DemoController],
      providers: [
        { provide: AppLogger, useValue: { info: jest.fn() } },
        { provide: PublishMessage, useValue: publish },
        { provide: GetReceipt, useValue: getReceipt },
      ],
    }).compile();
    app = module.createNestApplication();
    const logger = app.get(AppLogger);
    const correlation = new CorrelationMiddleware(logger);
    app.use(correlation.use.bind(correlation));
    configureApi(app);
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    publish.execute.mockReset();
    getReceipt.execute.mockReset();
  });

  it.each([
    {},
    { message: '' },
    { message: ' \t\n' },
    { message: 3 },
    { message: 'a'.repeat(501) },
    { message: 'hello', extra: true },
  ])('rejects invalid input: %j', async (body) => {
    const response = await request(app.getHttpServer())
      .post('/demo/messages')
      .send(body)
      .expect(400);
    expect(response.body.correlationId).toBe(
      response.headers['x-correlation-id'],
    );
    expect(publish.execute).not.toHaveBeenCalled();
  });
  it('returns 202 and propagates the request correlation ID', async () => {
    const input = event();
    publish.execute.mockResolvedValue({
      eventId: input.eventId,
      status: 'published',
    });
    const response = await request(app.getHttpServer())
      .post('/demo/messages')
      .set('x-correlation-id', input.correlationId)
      .send({ message: input.message })
      .expect(202);
    expect(response.body).toEqual({
      eventId: input.eventId,
      status: 'published',
    });
    expect(publish.execute).toHaveBeenCalledWith(
      input.message,
      input.correlationId,
    );
  });
  it('returns 503 when publication cannot be confirmed', async () => {
    publish.execute.mockRejectedValue(new Error('broker unavailable'));
    const response = await request(app.getHttpServer())
      .post('/demo/messages')
      .send({ message: 'hello' })
      .expect(503);
    expect(response.body.message).toBe(
      'Message publication could not be confirmed',
    );
  });
  it('returns a persisted receipt', async () => {
    const saved = receipt();
    getReceipt.execute.mockResolvedValue(saved);
    const response = await request(app.getHttpServer())
      .get(`/demo/messages/${saved.eventId}`)
      .expect(200);
    expect(response.body).toEqual(saved);
  });
  it('returns 404 before a receipt exists', async () => {
    getReceipt.execute.mockResolvedValue(null);
    await request(app.getHttpServer())
      .get(`/demo/messages/${event().eventId}`)
      .expect(404);
  });
  it('rejects malformed event IDs', async () => {
    await request(app.getHttpServer())
      .get('/demo/messages/not-a-uuid')
      .expect(400);
    expect(getReceipt.execute).not.toHaveBeenCalled();
  });
  it('documents successful and error responses', () => {
    const spec = createOpenApiDocument(app);
    expect(spec.paths['/demo/messages']?.post?.responses).toHaveProperty('202');
    expect(spec.paths['/demo/messages']?.post?.responses).toHaveProperty('503');
    expect(spec.components?.schemas).toHaveProperty('ErrorResponseDto');
  });
});
