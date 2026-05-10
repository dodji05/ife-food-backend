import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter } as any);

async function main() {
  console.log('🌱 Seeding ifè FOOD database...');

  // ── 1. Platform Config ────────────────────
  const configs = [
    { key: 'commission',                  value: { type: 'PERCENTAGE', value: 15 } },
    { key: 'deliveryFeePerKm',            value: 150 },
    { key: 'cancellationDeadlineMinutes', value: 5 },
    { key: 'paymentGateways',             value: { STRIPE: true, PAYPAL: true, KKIAPAY: true, FEDAPAY: true } },
    { key: 'weatherSurcharge',            value: { enabled: true, multiplier: 1.3 } },
  ];
  for (const cfg of configs) {
    await prisma.platformConfig.upsert({ where: { key: cfg.key }, update: { value: cfg.value as any }, create: { key: cfg.key, value: cfg.value as any } });
  }
  console.log('✅ Platform configs');

  // ── 2. Super Admin ────────────────────────
  const adminPhone = process.env.ADMIN_PHONE || '+22991000000';
  let adminUser = await prisma.user.findUnique({ where: { phone: adminPhone } });
  if (!adminUser) {
    adminUser = await prisma.user.create({
      data: { phone: adminPhone, phoneCountry: 'BJ', name: 'Super Admin', firstName: 'ifè', role: 'ADMIN', status: 'ACTIVE', lang: 'fr', countryCode: 'BJ', currency: 'XOF' },
    });
    await prisma.admin.create({ data: { userId: adminUser.id, level: 'SUPER_ADMIN' } });
  }
  console.log(`✅ Super admin: ${adminPhone}`);

  // ── 3. Legal Pages ────────────────────────
  const langs = ['fr', 'en', 'es', 'de', 'ru', 'ar', 'zh'] as const;
  const pages = [
    { type: 'ABOUT',        fr: { title: 'À propos de ifè FOOD', content: 'ifè FOOD est une plateforme de livraison opérée par Ets SWK FAKEYE au Bénin.' }, en: { title: 'About ifè FOOD', content: 'ifè FOOD is a delivery platform operated by Ets SWK FAKEYE in Benin.' } },
    { type: 'CGU',          fr: { title: "Conditions Générales d'Utilisation", content: 'En utilisant ifè FOOD, vous acceptez les présentes CGU. Vous devez avoir 18 ans minimum.' }, en: { title: 'Terms of Service', content: 'By using ifè FOOD, you agree to these Terms. You must be at least 18 years old.' } },
    { type: 'CGV',          fr: { title: 'Conditions Générales de Vente', content: 'Les commandes sont soumises aux CGV. Les prix incluent toutes les taxes.' }, en: { title: 'General Sales Conditions', content: 'Orders are subject to these conditions. Prices include all taxes.' } },
    { type: 'PRIVACY',      fr: { title: 'Politique de confidentialité', content: 'Vos données personnelles sont collectées uniquement pour le fonctionnement de la plateforme et ne sont jamais vendues.' }, en: { title: 'Privacy Policy', content: 'Your personal data is collected only for platform operation and is never sold.' } },
    { type: 'DRIVER_CHARTER', fr: { title: 'Charte des livreurs', content: 'En tant que livreur, vous vous engagez à respecter les délais et à traiter les clients avec respect.' }, en: { title: 'Driver Charter', content: 'As a driver, you commit to respecting deadlines and treating clients with respect.' } },
    { type: 'PRO_CHARTER',  fr: { title: 'Charte des professionnels', content: 'En tant que partenaire, vous vous engagez à maintenir la qualité de vos produits et à respecter les délais.' }, en: { title: 'Professional Charter', content: 'As a professional partner, you commit to maintaining product quality and respecting preparation times.' } },
    { type: 'FAQ',          fr: { title: 'FAQ', content: 'Q: Comment suivre ma commande ?\nR: En temps réel via la carte.\n\nQ: Puis-je annuler ?\nR: Oui, dans les 5 minutes.' }, en: { title: 'FAQ', content: 'Q: How do I track my order?\nA: In real-time via the map.\n\nQ: Can I cancel?\nA: Yes, within 5 minutes.' } },
  ];

  for (const page of pages) {
    for (const lang of langs) {
      const content = (page as any)[lang] ?? (page as any)['en'];
      await prisma.legalPage.upsert({
        where: { type_lang: { type: page.type, lang } },
        update: content,
        create: { type: page.type, lang, ...content, version: '1.0' },
      });
    }
  }
  console.log('✅ Legal pages (7 languages × 7 types)');

  // ── 4. Delivery Zones (Bénin) ─────────────
  const zones = [
    { name: 'Cotonou → Cotonou',       country: 'BJ', fromCity: 'Cotonou',    toCity: 'Cotonou',       baseFee: 500,  perKmFee: 100, currency: 'XOF' },
    { name: 'Cotonou → Abomey-Calavi', country: 'BJ', fromCity: 'Cotonou',    toCity: 'Abomey-Calavi', baseFee: 1500, perKmFee: 150, currency: 'XOF' },
    { name: 'Porto-Novo → Porto-Novo', country: 'BJ', fromCity: 'Porto-Novo', toCity: 'Porto-Novo',    baseFee: 600,  perKmFee: 100, currency: 'XOF' },
    { name: 'Parakou → Parakou',       country: 'BJ', fromCity: 'Parakou',    toCity: 'Parakou',       baseFee: 700,  perKmFee: 120, currency: 'XOF' },
    { name: 'Cotonou → Porto-Novo',    country: 'BJ', fromCity: 'Cotonou',    toCity: 'Porto-Novo',    baseFee: 2000, perKmFee: 200, currency: 'XOF' },
    { name: 'Bohicon → Bohicon',       country: 'BJ', fromCity: 'Bohicon',    toCity: 'Bohicon',       baseFee: 600,  perKmFee: 110, currency: 'XOF' },
  ];
  for (const zone of zones) {
    await prisma.deliveryZone.create({ data: zone });
  }
  console.log('✅ Delivery zones (Bénin)');

  // ── 5. Exchange Rates ─────────────────────
  const rates = [
    { fromCurrency: 'EUR', toCurrency: 'XOF', rate: 655.957 },
    { fromCurrency: 'USD', toCurrency: 'XOF', rate: 600.0   },
    { fromCurrency: 'XOF', toCurrency: 'EUR', rate: 0.001524 },
    { fromCurrency: 'XOF', toCurrency: 'USD', rate: 0.001667 },
    { fromCurrency: 'GBP', toCurrency: 'XOF', rate: 760.0   },
    { fromCurrency: 'NGN', toCurrency: 'XOF', rate: 0.42    },
    { fromCurrency: 'USD', toCurrency: 'EUR', rate: 0.92    },
    { fromCurrency: 'EUR', toCurrency: 'USD', rate: 1.09    },
  ];
  for (const rate of rates) {
    await prisma.exchangeRate.upsert({
      where: { fromCurrency_toCurrency: { fromCurrency: rate.fromCurrency, toCurrency: rate.toCurrency } },
      update: { rate: rate.rate },
      create: rate,
    });
  }
  console.log('✅ Exchange rates');

  // ── 6. Default Banner ─────────────────────
  await prisma.banner.create({
    data: {
      title: { fr: 'Bienvenue sur ifè FOOD ! 🍽️', en: 'Welcome to ifè FOOD! 🍽️' },
      imageUrl: 'https://placehold.co/1200x400/e74c3c/white?text=ife+FOOD',
      countries: [],
      sortOrder: 0,
      isActive: true,
    },
  });
  console.log('✅ Welcome banner');

  // ── 7. Promo Code ─────────────────────────
  await prisma.promoCode.create({
    data: {
      code: 'BIENVENUE10',
      type: 'PERCENTAGE',
      value: 10,
      minOrder: 2000,
      maxUses: 1000,
      perUser: true,
      countries: ['BJ'],
      isActive: true,
    },
  });
  console.log('✅ Promo code: BIENVENUE10 (10% off, min 2000 XOF)');

  console.log('\n🎉 Seed completed successfully!');
  console.log(`👤 Admin: ${adminPhone} → request OTP to login`);
}

main()
  .catch((e) => { console.error('❌ Seed failed:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
