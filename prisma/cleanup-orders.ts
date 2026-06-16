/**
 * Supprime TOUTES les commandes et toutes les données liées.
 * Rien d'autre n'est touché (users, products, pros, drivers, notifications...).
 *
 * Exécuter sur le VPS :
 *   cd /home/debian/PROJETS/Mouka/ife-food-backend
 *   npx ts-node prisma/cleanup-orders.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔍 Comptage avant suppression...');
  const counts = {
    promoCodeUsages : await prisma.promoCodeUsage.count(),
    reviews         : await prisma.review.count(),
    deliveries      : await prisma.delivery.count(),
    payments        : await prisma.payment.count(),
    orderItems      : await prisma.orderItem.count(),
    orders          : await prisma.order.count(),
    transactions    : await prisma.transaction.count({ where: { orderId: { not: null } } }),
  };
  console.table(counts);

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) {
    console.log('✅ Aucune commande à supprimer.');
    return;
  }

  console.log('\n🗑️  Suppression en cours...');

  await prisma.$transaction([
    // 1. Usages de codes promo liés aux commandes
    prisma.promoCodeUsage.deleteMany(),

    // 2. Avis (reviews)
    prisma.review.deleteMany(),

    // 3. Livraisons
    prisma.delivery.deleteMany(),

    // 4. Paiements
    prisma.payment.deleteMany(),

    // 5. Lignes de commande
    prisma.orderItem.deleteMany(),

    // 6. Commandes
    prisma.order.deleteMany(),

    // 7. Détacher le lien orderId dans les transactions (sans supprimer les transactions)
    prisma.transaction.updateMany({
      where: { orderId: { not: null } },
      data:  { orderId: null },
    }),
  ]);

  console.log('\n✅ Suppression terminée.');
  console.log('   PromoCodeUsages :', counts.promoCodeUsages);
  console.log('   Reviews         :', counts.reviews);
  console.log('   Deliveries      :', counts.deliveries);
  console.log('   Payments        :', counts.payments);
  console.log('   OrderItems      :', counts.orderItems);
  console.log('   Orders          :', counts.orders);
  console.log('   Transactions.orderId remis à null :', counts.transactions);
}

main()
  .catch((e) => { console.error('❌ Erreur :', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
