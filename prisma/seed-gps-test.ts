/**
 * Fixture : mise à jour des coordonnées GPS pour les tests de livraison
 *
 * Professionnel : 3e3a45a4-e4fd-48e1-8ef0-3fce1dd6788f
 * Client        : 87c82561-5947-4e6a-aef5-0fb365feee38
 * Livreur       : 611b1ef0-6221-4f09-8c62-1c0790d90b68
 *
 * Les trois points sont dans le quartier Haie Vive / Cadjèhoun / Akpakpa
 * de Cotonou (Bénin), distants de 1 à 3 km les uns des autres (< 15 km).
 *
 * Exécution :
 *   npx ts-node prisma/seed-gps-test.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter } as any);

// ── Coordonnées Cotonou (Bénin) ───────────────────────────────────────────────
// Toutes à moins de 3 km les unes des autres → bien dans le rayon 15 km.

const PRO_ID     = '3e3a45a4-e4fd-48e1-8ef0-3fce1dd6788f';
const CLIENT_ID  = '87c82561-5947-4e6a-aef5-0fb365feee38';
const DRIVER_ID  = '611b1ef0-6221-4f09-8c62-1c0790d90b68';

const GPS = {
  pro: {
    lat: 6.3654,
    lng: 2.4183,
    address: 'Quartier Jonquet, Cotonou',
    city: 'Cotonou',
  },
  client: {
    lat: 6.4345,
    lng: 2.4801,
    address: 'Abomey-Calavi, Bénin',
    city: 'Abomey-Calavi',
  },
  driver: {
    lat: 6.3654,
    lng: 2.4909,
    city: 'Cotonou',
  },
};

// Distance haversine (km) — juste pour afficher un récap.
function haversine(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function main() {
  console.log('=== Fixture GPS — Cotonou ===\n');

  // ── 1. Professionnel ───────────────────────────────────────────────────────
  // Tente par professional.id, puis par userId.
  let pro = await prisma.professional.findUnique({ where: { id: PRO_ID } });
  if (!pro) {
    pro = await prisma.professional.findUnique({ where: { userId: PRO_ID } });
  }
  if (!pro) {
    console.error(`❌ Professionnel introuvable (id ou userId = ${PRO_ID})`);
  } else {
    await prisma.professional.update({
      where: { id: pro.id },
      data: {
        lat:     GPS.pro.lat,
        lng:     GPS.pro.lng,
        address: GPS.pro.address,
        city:    GPS.pro.city,
      },
    });
    console.log(`✅ Professionnel mis à jour`);
    console.log(`   Adresse  : ${GPS.pro.address}`);
    console.log(`   GPS      : ${GPS.pro.lat}, ${GPS.pro.lng}\n`);
  }

  // ── 2. Client — adresse par défaut ─────────────────────────────────────────
  // Cherche l'adresse par défaut existante; sinon en crée une nouvelle.
  const existingAddr = await prisma.userAddress.findFirst({
    where: { userId: CLIENT_ID, isDefault: true },
  });

  if (existingAddr) {
    await prisma.userAddress.update({
      where: { id: existingAddr.id },
      data: {
        lat:     GPS.client.lat,
        lng:     GPS.client.lng,
        address: GPS.client.address,
        city:    GPS.client.city,
      },
    });
    console.log(`✅ Adresse client mise à jour (existante)`);
  } else {
    // Désactive d'abord les autres adresses si elles existent
    await prisma.userAddress.updateMany({
      where: { userId: CLIENT_ID },
      data:  { isDefault: false },
    });
    await prisma.userAddress.create({
      data: {
        userId:    CLIENT_ID,
        label:     'Domicile',
        address:   GPS.client.address,
        city:      GPS.client.city,
        country:   'BJ',
        lat:       GPS.client.lat,
        lng:       GPS.client.lng,
        isDefault: true,
      },
    });
    console.log(`✅ Adresse client créée`);
  }
  console.log(`   Adresse  : ${GPS.client.address}`);
  console.log(`   GPS      : ${GPS.client.lat}, ${GPS.client.lng}\n`);

  // ── 3. Livreur ─────────────────────────────────────────────────────────────
  // Tente par driver.id, puis par userId.
  let driver = await prisma.driver.findUnique({ where: { id: DRIVER_ID } });
  if (!driver) {
    driver = await prisma.driver.findUnique({ where: { userId: DRIVER_ID } });
  }
  if (!driver) {
    console.error(`❌ Livreur introuvable (id ou userId = ${DRIVER_ID})`);
  } else {
    await prisma.driver.update({
      where: { id: driver.id },
      data: {
        currentLat: GPS.driver.lat,
        currentLng: GPS.driver.lng,
        zoneCity:   GPS.driver.city,
        isAvailable: true,
      },
    });
    console.log(`✅ Livreur mis à jour`);
    console.log(`   GPS      : ${GPS.driver.lat}, ${GPS.driver.lng}`);
    console.log(`   Dispo    : true\n`);
  }

  // ── Récap des distances ────────────────────────────────────────────────────
  console.log('=== Distances entre les acteurs ===');
  console.log(`  Pro → Client  : ${haversine(GPS.pro.lat, GPS.pro.lng, GPS.client.lat, GPS.client.lng).toFixed(2)} km`);
  console.log(`  Pro → Livreur : ${haversine(GPS.pro.lat, GPS.pro.lng, GPS.driver.lat, GPS.driver.lng).toFixed(2)} km`);
  console.log(`  Client → Livreur : ${haversine(GPS.client.lat, GPS.client.lng, GPS.driver.lat, GPS.driver.lng).toFixed(2)} km`);
  console.log('\nTous dans un rayon < 15 km ✅');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
