import * as dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcrypt';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  const phone = process.env.SEED_ADMIN_PHONE;

  if (!email || !password || !phone) {
    throw new Error(
      'Variables manquantes : SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_ADMIN_PHONE',
    );
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Admin ${email} existe déjà. Mise à jour du mot de passe.`);
    const hash = await bcrypt.hash(password, 12);
    await prisma.user.update({ where: { email }, data: { pinHash: hash } });
    console.log('Mot de passe mis à jour.');
    return;
  }

  const hash = await bcrypt.hash(password, 12);

  const user = await prisma.user.create({
    data: {
      phone,
      phoneCountry: phone.substring(0, 4),
      email,
      name: 'Admin',
      firstName: 'Super',
      role: 'ADMIN',
      status: 'ACTIVE',
      pinHash: hash,
      admin: {
        create: { level: 'SUPER_ADMIN' },
      },
    },
  });

  console.log(`✅ Compte SUPER_ADMIN créé : ${user.email} (id: ${user.id})`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
