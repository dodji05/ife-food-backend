import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import * as cookieParser from 'cookie-parser';
import { join } from 'path';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);
  const nodeEnv = configService.get<string>('NODE_ENV', 'development');

  // Security
  app.use(helmet());
  app.use(cookieParser());
  const frontendUrl = configService.get<string>('FRONTEND_URL');
  if (!frontendUrl && nodeEnv === 'production') {
    throw new Error('FRONTEND_URL doit être défini en production');
  }
  // Liste blanche : frontend web + mobile (origin absent / capacitor / file://).
  const allowedWebOrigins = (frontendUrl ?? 'http://localhost:4200')
      .split(',').map((o) => o.trim());
  app.enableCors({
    origin: (origin, cb) => {
      // Requêtes sans origin (apps mobiles natives, curl, server-to-server) → autorisées
      if (!origin) return cb(null, true);
      if (allowedWebOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS: origin ${origin} non autorisé`), false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // Global prefix & versioning
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // Global pipes, filters, interceptors
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());

  // Fichiers uploadés servis statiquement à /uploads/**
  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads' });

  // Swagger (disabled in production)
  if (nodeEnv !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('ifè FOOD API')
      .setDescription('REST API for ifè FOOD platform — Ets SWK FAKEYE, Bénin')
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'JWT')
      .addTag('auth', 'Authentication & OTP')
      .addTag('users', 'User management')
      .addTag('professionals', 'Professionals (restaurants, shops)')
      .addTag('drivers', 'Delivery drivers')
      .addTag('products', 'Product catalogue')
      .addTag('orders', 'Order management')
      .addTag('payments', 'Payment processing')
      .addTag('deliveries', 'Delivery tracking')
      .addTag('reviews', 'Ratings & reviews')
      .addTag('notifications', 'Push notifications')
      .addTag('messages', 'In-app messaging')
      .addTag('admin', 'Admin back-office')
      .addTag('config', 'Platform configuration')
      .addTag('geo', 'Geolocation & maps')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
    console.log(`📚 Swagger: http://localhost:${port}/api/docs`);
  }

  await app.listen(port);
  console.log(`🚀 ifè FOOD API running on http://localhost:${port}/api/v1`);
  console.log(`🌍 Environment: ${nodeEnv}`);
}
bootstrap();
