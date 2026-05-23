/**
 * seed-active-orders.ts — ifè FOOD
 * ─────────────────────────────────────────────────────────────────────────────
 * Crée des commandes dans des états intermédiaires pour le dashboard pro :
 *   • PAID          → payée, en attente d'acceptation par le pro
 *   • IN_PREPARATION → acceptée, en cours de préparation
 *
 * Idempotent : tag [ACTIVE-SEED] dans specialInstructions.
 * Usage (VPS) : npm run seed:active-orders
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as path   from 'node:path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(process.cwd(), '.env') });

import { PrismaClient } from '@prisma/client';
import { PrismaPg }     from '@prisma/adapter-pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL absent — vérifier que le .env existe à la racine du backend.');
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma  = new PrismaClient({ adapter });

const CLIENT_IDS = [
  '87c82561-5947-4e6a-aef5-0fb365feee38',
  'd3704392-1b9b-49a2-bd72-b9e18d831e9f',
  '30ceaa9b-74ec-4aa4-9d19-bf534647a612',
] as const;

const SHOP_IDS = [
  '443dc40f-8ebc-4b94-9e9e-d4c6accfe6e3',
  '3b4b0e0a-20d7-47da-b999-62257d384755',
] as const;

const SEED_TAG   = '[ACTIVE-SEED]';
const COMMISSION = 0.10;
const CURRENCY   = 'XOF';

const CLIENT_ADDRESSES = [
  { address: 'Lot 132, Quartier Cadjehoun, près du carrefour SCOA',           lat: 6.3654, lng: 2.4183, city: 'Cotonou', country: 'BJ' },
  { address: "Villa 58, Haie Vive, derrière l'ambassade des USA",             lat: 6.3721, lng: 2.4022, city: 'Cotonou', country: 'BJ' },
  { address: 'Rue 12.148, Quartier Gbèdjromèdé, face pharmacie Saint-Michel', lat: 6.3611, lng: 2.4312, city: 'Cotonou', country: 'BJ' },
] as const;

const rand = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const pick = <T>(arr: T[], n: number): T[] =>
  [...arr].sort(() => Math.random() - 0.5).slice(0, Math.min(n, arr.length));

// ─── Commandes à générer ──────────────────────────────────────────────────────
interface ActiveConf {
  clientIdx: 0 | 1 | 2;
  shopIdx:   0 | 1;
  status:    'PAID' | 'IN_PREPARATION';
  itemCount: number;
  payMethod: 'KKIAPAY' | 'CASH_ON_DELIVERY' | 'FEDAPAY';
  minutesAgo: number;   // depuis combien de minutes la commande a été passée
}

const ACTIVE_ORDERS: ActiveConf[] = [
  // ── PAID (à valider par le pro) ─────────────────────────────────────────
  { clientIdx: 0, shopIdx: 0, status: 'PAID',           itemCount: 2, payMethod: 'KKIAPAY',          minutesAgo:  4 },
  { clientIdx: 1, shopIdx: 1, status: 'PAID',           itemCount: 1, payMethod: 'FEDAPAY',           minutesAgo:  7 },
  { clientIdx: 2, shopIdx: 0, status: 'PAID',           itemCount: 3, payMethod: 'CASH_ON_DELIVERY',  minutesAgo: 11 },

  // ── IN_PREPARATION (en cours de préparation) ─────────────────────────────
  { clientIdx: 1, shopIdx: 0, status: 'IN_PREPARATION', itemCount: 2, payMethod: 'KKIAPAY',          minutesAgo: 18 },
  { clientIdx: 0, shopIdx: 1, status: 'IN_PREPARATION', itemCount: 1, payMethod: 'KKIAPAY',          minutesAgo: 22 },
  { clientIdx: 2, shopIdx: 1, status: 'IN_PREPARATION', itemCount: 2, payMethod: 'FEDAPAY',           minutesAgo: 30 },
];

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ifè FOOD — Seed commandes actives (PAID + IN_PREPARATION)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // ── 1. Idempotence ──────────────────────────────────────────────────────────
  const existing = await prisma.order.count({
    where: { specialInstructions: { contains: SEED_TAG } },
  });
  if (existing > 0) {
    console.log(`⚠️  ${existing} commande(s) [ACTIVE-SEED] déjà présentes — abandon.`);
    console.log('   Pour relancer : DELETE FROM orders WHERE "specialInstructions" LIKE \'%[ACTIVE-SEED]%\';');
    return;
  }

  // ── 2. Acteurs ──────────────────────────────────────────────────────────────
  console.log('1/3  Vérification des acteurs…');
  const [clients, shops] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...CLIENT_IDS] } }, select: { id: true, firstName: true, phone: true } }),
    prisma.professional.findMany({ where: { id: { in: [...SHOP_IDS] } }, select: { id: true, businessName: true, status: true, userId: true } }),
  ]);

  if (clients.length !== CLIENT_IDS.length) throw new Error('Client(s) introuvable(s)');
  if (shops.length   !== SHOP_IDS.length)   throw new Error('Boutique(s) introuvable(s)');
  for (const s of shops) {
    if (s.status !== 'VALIDATED') throw new Error(`Boutique ${s.businessName} non validée (statut: ${s.status})`);
  }

  clients.forEach(c => console.log(`   ✓ Client  : ${c.firstName ?? c.phone} (${c.id.slice(0, 8)}…)`));
  shops.forEach(s   => console.log(`   ✓ Boutique: ${s.businessName}`));

  // ── 3. Produits ─────────────────────────────────────────────────────────────
  console.log('\n2/3  Chargement des produits…');
  const productsByShop: Array<{ id: string; price: number }[]> = [];
  for (const shop of shops) {
    const prods = await prisma.product.findMany({
      where: { professionalId: shop.id, isAvailable: true },
      select: { id: true, price: true },
    });
    if (prods.length === 0) throw new Error(`Aucun produit chez ${shop.businessName}`);
    productsByShop.push(prods);
    console.log(`   ✓ ${prods.length} produit(s) chez ${shop.businessName}`);
  }

  // ── 4. Création des commandes ───────────────────────────────────────────────
  console.log('\n3/3  Création des commandes…\n');

  let created = 0;
  for (const conf of ACTIVE_ORDERS) {
    const clientId = CLIENT_IDS[conf.clientIdx];
    const shop     = shops[conf.shopIdx];
    const products = productsByShop[conf.shopIdx];
    const addr     = CLIENT_ADDRESSES[conf.clientIdx];

    const selected  = pick(products, conf.itemCount);
    const orderItems = selected.map(p => ({
      productId:  p.id,
      quantity:   rand(1, 2),
      unitPrice:  p.price,
      totalPrice: p.price * rand(1, 2),
    }));
    const subtotal         = orderItems.reduce((s, i) => s + i.totalPrice, 0);
    const deliveryFee      = rand(700, 1200);
    const totalAmount      = subtotal + deliveryFee;
    const commissionAmount = Math.round(subtotal * COMMISSION);

    const createdAt  = new Date(Date.now() - conf.minutesAgo * 60_000);
    const acceptedAt = conf.status === 'IN_PREPARATION'
      ? new Date(createdAt.getTime() + rand(2, 5) * 60_000)
      : null;

    await prisma.order.create({
      data: {
        clientId:            clientId,
        professionalId:      shop.id,
        status:              conf.status,
        paymentStatus:       'SUCCESS',
        paymentMethod:       conf.payMethod,
        subtotal,
        deliveryFee,
        taxAmount:           0,
        commissionAmount,
        totalAmount,
        tipAmount:           0,
        currency:            CURRENCY,
        deliveryAddress:     addr.address,
        deliveryLat:         addr.lat,
        deliveryLng:         addr.lng,
        deliveryCity:        addr.city,
        deliveryCountry:     addr.country,
        specialInstructions: SEED_TAG,
        estimatedDeliveryMin: 40,
        createdAt,
        updatedAt:           acceptedAt ?? createdAt,
        items: { create: orderItems },
        payment: {
          create: {
            gateway:    conf.payMethod,
            amount:     totalAmount,
            currency:   CURRENCY,
            status:     'SUCCESS',
            gatewayRef: `active-${Math.random().toString(36).slice(2, 12)}`,
            createdAt,
            updatedAt:  createdAt,
          },
        },
      },
      select: { id: true },
    });

    // Notifications pro (ORDER_NEW) et client si IN_PREPARATION (ORDER_ACCEPTED)
    const notifs: any[] = [
      {
        userId:    shop.userId,
        type:      'ORDER_NEW',
        title:     'Nouvelle commande !',
        body:      `Un client a passé une commande de ${totalAmount.toLocaleString()} F — ${shop.businessName}`,
        data:      {},
        read:      false,
        createdAt,
      },
    ];
    if (conf.status === 'IN_PREPARATION') {
      notifs.push({
        userId:    clientId,
        type:      'ORDER_ACCEPTED',
        title:     'Commande acceptée',
        body:      `${shop.businessName} a accepté votre commande et la prépare.`,
        data:      {},
        read:      false,
        createdAt: acceptedAt ?? createdAt,
      });
    }
    await prisma.notification.createMany({ data: notifs });

    const label = conf.status === 'PAID' ? '⏳ PAID (à valider)     ' : '👨‍🍳 IN_PREPARATION       ';
    console.log(`   ${label} → ${shop.businessName} | ${totalAmount.toLocaleString()} F | il y a ${conf.minutesAgo} min`);
    created++;
  }

  console.log(`\n✅  ${created} commande(s) créées avec succès.\n`);
}

main()
  .catch(e => { console.error('\n✗ Erreur :', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
