/**
 * ─────────────────────────────────────────────────────────────────────────
 * One-shot — crée 4 commandes démo pour un client/pro/driver donnés.
 *
 *   • 2 DELIVERED   livrées par le driver (Payment SUCCESS + Delivery)
 *   • 1 PENDING_PAYMENT  (sans driver, Payment PENDING)
 *   • 1 CANCELLED   (sans driver, Payment PENDING, cancelledBy = client)
 *
 * Idempotent : si au moins une commande tagguée [DEMO-SEED] existe déjà
 * pour le couple client+pro, le script ne fait rien (pour éviter les
 * doublons). Pour relancer : supprimer manuellement les commandes démo
 * (cf. requête SQL en bas du fichier) puis ré-exécuter.
 *
 * Usage (sur le VPS) :
 *   cd /home/debian/PROJETS/Mouka/ife-food-backend
 *   npm run seed:demo-orders
 *
 * ─────────────────────────────────────────────────────────────────────────
 */

import * as path from 'node:path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(process.cwd(), '.env') });

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL absent — vérifier que le .env existe à la racine du backend.');
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// ── Acteurs ────────────────────────────────────────────────────────────────
const CLIENT_ID       = '87c82561-5947-4e6a-aef5-0fb365feee38';
const PROFESSIONAL_ID = '443dc40f-8ebc-4b94-9e9e-d4c6accfe6e3';
const OWNER_ID        = '3e3a45a4-e4fd-48e1-8ef0-3fce1dd6788f';
const DRIVER_ID       = '611b1ef0-6221-4f09-8c62-1c0790d90b68';

// ── Constantes métier ──────────────────────────────────────────────────────
const DEMO_TAG = '[DEMO-SEED]';
const COMMISSION_FALLBACK = 0.10; // 10 % si pro.commissionRate est null

// Adresse de livraison fictive — Cotonou, quartier Cadjehoun
const DELIVERY_ADDRESS = 'Lot 245, Quartier Cadjehoun, près du carrefour SCOA, Cotonou';
const DELIVERY_LAT     = 6.3654;
const DELIVERY_LNG     = 2.4183;
const DELIVERY_CITY    = 'Cotonou';
const DELIVERY_COUNTRY = 'BJ';

// ── Helpers ────────────────────────────────────────────────────────────────
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(10 + Math.floor(Math.random() * 8), Math.floor(Math.random() * 60), 0, 0);
  return d;
};

const pick = <T,>(arr: T[], n: number): T[] => {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
};

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Seed démo — 4 commandes pour le client cible');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // ─── 1. Vérifications de cohérence ───────────────────────────────────────
  const [client, pro, owner, driver] = await Promise.all([
    prisma.user.findUnique({ where: { id: CLIENT_ID } }),
    prisma.professional.findUnique({ where: { id: PROFESSIONAL_ID } }),
    prisma.user.findUnique({ where: { id: OWNER_ID } }),
    prisma.driver.findUnique({ where: { id: DRIVER_ID }, include: { user: true } }),
  ]);

  if (!client)  throw new Error(`Client ${CLIENT_ID} introuvable`);
  if (!pro)     throw new Error(`Professional ${PROFESSIONAL_ID} introuvable`);
  if (!owner)   throw new Error(`Owner ${OWNER_ID} introuvable`);
  if (!driver)  throw new Error(`Driver ${DRIVER_ID} introuvable`);

  if (client.role !== 'CLIENT')
    throw new Error(`User ${CLIENT_ID} a le rôle ${client.role} (attendu CLIENT)`);
  if (pro.userId !== OWNER_ID)
    throw new Error(`La boutique ${PROFESSIONAL_ID} appartient à ${pro.userId}, pas à ${OWNER_ID}`);
  if (pro.status !== 'VALIDATED')
    throw new Error(`La boutique ${pro.businessName} a le statut ${pro.status} (attendu VALIDATED)`);
  if (!['VALIDATED', 'ONLINE', 'OFFLINE'].includes(driver.status))
    throw new Error(`Driver ${DRIVER_ID} a le statut ${driver.status} (attendu VALIDATED|ONLINE|OFFLINE)`);

  console.log(`✓ Client     : ${[client.firstName, client.name].filter(Boolean).join(' ') || client.phone}`);
  console.log(`✓ Boutique   : ${pro.businessName}  (owner: ${[owner.firstName, owner.name].filter(Boolean).join(' ') || owner.phone})`);
  console.log(`✓ Livreur    : ${[driver.user.firstName, driver.user.name].filter(Boolean).join(' ') || driver.user.phone}\n`);

  // ─── 2. Produits du pro (au moins 1 requis) ──────────────────────────────
  const products = await prisma.product.findMany({
    where: { professionalId: PROFESSIONAL_ID, isAvailable: true },
    take: 12,
  });
  if (products.length === 0) {
    throw new Error(`Aucun produit disponible chez ${pro.businessName} — impossible de générer des items`);
  }
  console.log(`✓ ${products.length} produit(s) disponible(s) chez ${pro.businessName}\n`);

  // ─── 3. Idempotence ──────────────────────────────────────────────────────
  const existing = await prisma.order.findMany({
    where: {
      clientId: CLIENT_ID,
      professionalId: PROFESSIONAL_ID,
      specialInstructions: { contains: DEMO_TAG },
    },
    select: { id: true, status: true },
  });
  if (existing.length > 0) {
    console.log(`ℹ ${existing.length} commande(s) démo déjà présente(s) pour ce couple client+pro :`);
    existing.forEach(o => console.log(`    ${o.id}  ${o.status}`));
    console.log('\nAucune création. Pour relancer, supprimer d\'abord les commandes démo :');
    console.log(`    DELETE FROM orders WHERE "clientId" = '${CLIENT_ID}' AND "professionalId" = '${PROFESSIONAL_ID}' AND "specialInstructions" LIKE '${DEMO_TAG}%';\n`);
    return;
  }

  // ─── 4. Construction des items + montants ────────────────────────────────
  const commission = Number(pro.commissionRate ?? COMMISSION_FALLBACK);
  const currency = client.currency || 'XOF';

  const buildItems = (count: number) => {
    const selected = pick(products, count);
    return selected.map(p => {
      const qty = 1 + Math.floor(Math.random() * 2); // 1 ou 2
      const unitPrice = Number(p.price);
      return {
        productId: p.id,
        quantity: qty,
        unitPrice,
        totalPrice: unitPrice * qty,
      };
    });
  };

  // ─── 5. Création des 4 commandes ─────────────────────────────────────────
  console.log('Création :');

  await createDeliveredOrder({
    items: buildItems(3),
    currency,
    commission,
    note: 'Sonner deux fois s\'il vous plaît',
    daysAgoCreated: 6,
  });

  await createDeliveredOrder({
    items: buildItems(2),
    currency,
    commission,
    note: 'Laisser au gardien si absent',
    daysAgoCreated: 2,
  });

  await createPendingOrder({
    items: buildItems(2),
    currency,
    commission,
  });

  await createCancelledOrder({
    items: buildItems(1),
    currency,
    commission,
  });

  console.log('\n✓ 4 commandes démo créées avec succès.\n');
}

interface OrderArgs {
  items: Array<{ productId: string; quantity: number; unitPrice: number; totalPrice: number }>;
  currency: string;
  commission: number;
}

async function createDeliveredOrder(args: OrderArgs & { note: string; daysAgoCreated: number }) {
  const { items, currency, commission, note, daysAgoCreated } = args;
  const subtotal = items.reduce((s, i) => s + i.totalPrice, 0);
  const deliveryFee = 800;
  const totalAmount = subtotal + deliveryFee;
  const commissionAmount = Math.round(subtotal * commission);

  const createdAt = daysAgo(daysAgoCreated);
  const pickupTime    = new Date(createdAt.getTime() + 25 * 60 * 1000); // +25 min
  const deliveredTime = new Date(createdAt.getTime() + 75 * 60 * 1000); // +1 h 15

  const order = await prisma.order.create({
    data: {
      clientId: CLIENT_ID,
      professionalId: PROFESSIONAL_ID,
      driverId: DRIVER_ID,
      status: 'DELIVERED',
      paymentStatus: 'SUCCESS',
      paymentMethod: 'KKIAPAY',
      subtotal,
      deliveryFee,
      taxAmount: 0,
      commissionAmount,
      totalAmount,
      currency,
      deliveryAddress: DELIVERY_ADDRESS,
      deliveryLat: DELIVERY_LAT,
      deliveryLng: DELIVERY_LNG,
      deliveryCity: DELIVERY_CITY,
      deliveryCountry: DELIVERY_COUNTRY,
      specialInstructions: `${DEMO_TAG} ${note}`,
      estimatedDeliveryMin: 30,
      createdAt,
      updatedAt: deliveredTime,
      items: { create: items },
      payment: {
        create: {
          gateway: 'KKIAPAY',
          amount: totalAmount,
          currency,
          status: 'SUCCESS',
          gatewayRef: `demo-${Math.random().toString(36).slice(2, 11)}`,
          createdAt,
          updatedAt: createdAt,
        },
      },
      delivery: {
        create: {
          driverId: DRIVER_ID,
          status: 'DELIVERED',
          pickupTime,
          deliveredTime,
          distanceKm: 4.2,
          createdAt,
          updatedAt: deliveredTime,
        },
      },
    },
  });
  console.log(`  ✓ DELIVERED  ${order.id}  ${totalAmount} ${currency}  ${items.length} item(s)`);
}

async function createPendingOrder(args: OrderArgs) {
  const { items, currency, commission } = args;
  const subtotal = items.reduce((s, i) => s + i.totalPrice, 0);
  const deliveryFee = 600;
  const totalAmount = subtotal + deliveryFee;
  const commissionAmount = Math.round(subtotal * commission);

  const now = new Date();

  const order = await prisma.order.create({
    data: {
      clientId: CLIENT_ID,
      professionalId: PROFESSIONAL_ID,
      status: 'PENDING_PAYMENT',
      paymentStatus: 'PENDING',
      paymentMethod: 'KKIAPAY',
      subtotal,
      deliveryFee,
      taxAmount: 0,
      commissionAmount,
      totalAmount,
      currency,
      deliveryAddress: DELIVERY_ADDRESS,
      deliveryLat: DELIVERY_LAT,
      deliveryLng: DELIVERY_LNG,
      deliveryCity: DELIVERY_CITY,
      deliveryCountry: DELIVERY_COUNTRY,
      specialInstructions: `${DEMO_TAG} En attente du paiement`,
      estimatedDeliveryMin: 35,
      createdAt: now,
      updatedAt: now,
      items: { create: items },
      payment: {
        create: {
          gateway: 'KKIAPAY',
          amount: totalAmount,
          currency,
          status: 'PENDING',
          createdAt: now,
          updatedAt: now,
        },
      },
    },
  });
  console.log(`  ✓ PENDING    ${order.id}  ${totalAmount} ${currency}  ${items.length} item(s)`);
}

async function createCancelledOrder(args: OrderArgs) {
  const { items, currency, commission } = args;
  const subtotal = items.reduce((s, i) => s + i.totalPrice, 0);
  const deliveryFee = 700;
  const totalAmount = subtotal + deliveryFee;
  const commissionAmount = Math.round(subtotal * commission);

  const createdAt   = daysAgo(1);
  const cancelledAt = new Date(createdAt.getTime() + 8 * 60 * 1000); // annulée 8 min après

  const order = await prisma.order.create({
    data: {
      clientId: CLIENT_ID,
      professionalId: PROFESSIONAL_ID,
      status: 'CANCELLED',
      paymentStatus: 'PENDING',
      paymentMethod: 'KKIAPAY',
      subtotal,
      deliveryFee,
      taxAmount: 0,
      commissionAmount,
      totalAmount,
      currency,
      deliveryAddress: DELIVERY_ADDRESS,
      deliveryLat: DELIVERY_LAT,
      deliveryLng: DELIVERY_LNG,
      deliveryCity: DELIVERY_CITY,
      deliveryCountry: DELIVERY_COUNTRY,
      specialInstructions: `${DEMO_TAG} Annulée par le client avant paiement`,
      estimatedDeliveryMin: 30,
      cancelledBy: CLIENT_ID,
      cancelledReason: 'Changement de plan, je commanderai plus tard',
      createdAt,
      updatedAt: cancelledAt,
      items: { create: items },
      payment: {
        create: {
          gateway: 'KKIAPAY',
          amount: totalAmount,
          currency,
          status: 'PENDING',
          createdAt,
          updatedAt: cancelledAt,
        },
      },
    },
  });
  console.log(`  ✓ CANCELLED  ${order.id}  ${totalAmount} ${currency}  ${items.length} item(s)`);
}

main()
  .catch((e) => {
    console.error('\n✗ Erreur :', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
