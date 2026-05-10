import path from 'node:path';
import { defineConfig } from 'prisma/config';
import * as dotenv from 'dotenv';

// Charger .env avant que Prisma lise les variables
dotenv.config({ path: path.join(process.cwd(), '.env') });

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  datasource: {
    url: process.env.DATABASE_URL as string,
  },
});
