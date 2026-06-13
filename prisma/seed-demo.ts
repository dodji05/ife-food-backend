/**
 * seed-demo.ts — Données de démonstration ifè FOOD
 *
 * Crée 2 restaurants avec produits et 1 épicerie pour tester l'application.
 *
 * Usage :
 *   npx ts-node -r tsconfig-paths/register prisma/seed-demo.ts
 *
 * Pré-requis : le seed principal (prisma/seed.ts) doit avoir été exécuté.
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter } as any);

async function main() {
  console.log('🍽️  Seeding demo data for ifè FOOD...\n');

  // ── 1. Utilisateur Professionnel 1 : Restaurant ───────────────────────────
  const pro1Phone = '+22997111001';
  let pro1User = await prisma.user.findUnique({ where: { phone: pro1Phone } });
  if (!pro1User) {
    pro1User = await prisma.user.create({
      data: {
        phone: pro1Phone,
        phoneCountry: 'BJ',
        name: 'Chez Maman Adjovi',
        firstName: 'Adjovi',
        role: 'PROFESSIONAL',
        status: 'ACTIVE',
        lang: 'fr',
        countryCode: 'BJ',
        currency: 'XOF',
      },
    });
  }

  // Profil restaurant 1
  let restaurant1 = await prisma.professional.findUnique({ where: { userId: pro1User.id } });
  if (!restaurant1) {
    restaurant1 = await prisma.professional.create({
      data: {
        userId: pro1User.id,
        businessName: 'Chez Maman Adjovi',
        category: 'RESTAURANT',
        description: 'Cuisine béninoise authentique — Ablo, Akassa, Sauce Graine et bien plus',
        address: 'Carrefour Saint-Michel, Cotonou',
        city: 'Cotonou',
        country: 'BJ',
        lat: 6.3702,
        lng: 2.3912,
        phone: pro1Phone,
        status: 'VALIDATED',
        isOpen: true,
        deliveryRadiusKm: 8,
        coverImageUrl: 'https://placehold.co/1200x400/e67e22/white?text=Chez+Maman+Adjovi',
        logoUrl: 'https://placehold.co/200x200/e67e22/white?text=CMA',
        openingHours: {
          lundi:    { open: '08:00', close: '22:00' },
          mardi:    { open: '08:00', close: '22:00' },
          mercredi: { open: '08:00', close: '22:00' },
          jeudi:    { open: '08:00', close: '22:00' },
          vendredi: { open: '08:00', close: '23:00' },
          samedi:   { open: '09:00', close: '23:00' },
          dimanche: { open: '10:00', close: '20:00' },
        },
      },
    });
  }
  console.log(`✅ Restaurant 1: ${restaurant1.businessName} (id: ${restaurant1.id})`);

  // Catégories de produits — Restaurant 1
  const cat1Plats = await prisma.productCategory.create({
    data: {
      name: { fr: 'Plats principaux', en: 'Main dishes' },
      sortOrder: 0,
    },
  });
  const cat1Boissons = await prisma.productCategory.create({
    data: {
      name: { fr: 'Boissons', en: 'Drinks' },
      sortOrder: 1,
    },
  });

  // Produits — Restaurant 1
  const produits1 = [
    { name: { fr: 'Riz gras au poulet', en: 'Chicken rice' }, price: 1500, cat: cat1Plats.id, desc: { fr: 'Riz parfumé au gras de poulet avec légumes', en: 'Fragrant chicken rice with vegetables' } },
    { name: { fr: 'Sauce graine + igname', en: 'Palm nut sauce + yam' }, price: 1800, cat: cat1Plats.id, desc: { fr: 'Sauce graine traditionnelle servie avec igname pilée', en: 'Traditional palm nut sauce served with pounded yam' } },
    { name: { fr: 'Ablo + poisson braisé', en: 'Ablo + grilled fish' }, price: 1200, cat: cat1Plats.id, desc: { fr: 'Ablo chaud avec poisson braisé et piment', en: 'Hot ablo with grilled fish and pepper sauce' } },
    { name: { fr: 'Akassa + sauce tomate', en: 'Akassa + tomato sauce' }, price: 1000, cat: cat1Plats.id, desc: { fr: 'Akassa frais avec sauce tomate épicée', en: 'Fresh akassa with spicy tomato sauce' } },
    { name: { fr: 'Pâte noire + sauce légumes', en: 'Black paste + vegetable sauce' }, price: 1300, cat: cat1Plats.id, desc: { fr: 'Pâte noire maison avec sauce aux légumes de saison', en: 'Homemade black paste with seasonal vegetable sauce' } },
    { name: { fr: 'Sodabi local (50cl)', en: 'Local Sodabi (50cl)' }, price: 500, cat: cat1Boissons.id, desc: { fr: 'Alcool de palme local distillé artisanalement', en: 'Locally distilled palm wine spirit' } },
    { name: { fr: 'Zoom-Koom (1L)', en: 'Zoom-Koom (1L)' }, price: 600, cat: cat1Boissons.id, desc: { fr: 'Boisson à base de farine de mil et de gingembre', en: 'Millet and ginger traditional drink' } },
    { name: { fr: 'Eau minérale (1,5L)', en: 'Mineral water (1.5L)' }, price: 350, cat: cat1Boissons.id, desc: { fr: 'Eau minérale fraîche', en: 'Fresh mineral water' } },
  ];

  for (const p of produits1) {
    await prisma.product.create({
      data: {
        professionalId: restaurant1.id,
        categoryId: p.cat,
        name: p.name,
        description: p.desc,
        price: p.price,
        currency: 'XOF',
        isAvailable: true,
        imageUrl: `https://placehold.co/400x300/e67e22/white?text=${encodeURIComponent((p.name as any).fr.split(' ')[0])}`,
      },
    });
  }
  console.log(`   → ${produits1.length} produits créés`);

  // ── 2. Utilisateur Professionnel 2 : Fast-food ────────────────────────────
  const pro2Phone = '+22997111002';
  let pro2User = await prisma.user.findUnique({ where: { phone: pro2Phone } });
  if (!pro2User) {
    pro2User = await prisma.user.create({
      data: {
        phone: pro2Phone,
        phoneCountry: 'BJ',
        name: 'Burger Palace Cotonou',
        firstName: 'Patronne',
        role: 'PROFESSIONAL',
        status: 'ACTIVE',
        lang: 'fr',
        countryCode: 'BJ',
        currency: 'XOF',
      },
    });
  }

  let restaurant2 = await prisma.professional.findUnique({ where: { userId: pro2User.id } });
  if (!restaurant2) {
    restaurant2 = await prisma.professional.create({
      data: {
        userId: pro2User.id,
        businessName: 'Burger Palace Cotonou',
        category: 'RESTAURANT',
        description: 'Burgers, pizzas et sandwichs — livraison rapide à Cotonou',
        address: 'Zone Résidentielle, Cotonou',
        city: 'Cotonou',
        country: 'BJ',
        lat: 6.3653,
        lng: 2.4183,
        phone: pro2Phone,
        status: 'VALIDATED',
        isOpen: true,
        deliveryRadiusKm: 10,
        coverImageUrl: 'https://placehold.co/1200x400/e74c3c/white?text=Burger+Palace',
        logoUrl: 'https://placehold.co/200x200/e74c3c/white?text=BP',
        openingHours: {
          lundi:    { open: '10:00', close: '23:00' },
          mardi:    { open: '10:00', close: '23:00' },
          mercredi: { open: '10:00', close: '23:00' },
          jeudi:    { open: '10:00', close: '23:00' },
          vendredi: { open: '10:00', close: '00:00' },
          samedi:   { open: '10:00', close: '00:00' },
          dimanche: { open: '11:00', close: '22:00' },
        },
      },
    });
  }
  console.log(`✅ Restaurant 2: ${restaurant2.businessName} (id: ${restaurant2.id})`);

  const cat2Burgers = await prisma.productCategory.create({
    data: {
      name: { fr: 'Burgers', en: 'Burgers' },
      sortOrder: 0,
    },
  });
  const cat2Pizzas = await prisma.productCategory.create({
    data: {
      name: { fr: 'Pizzas', en: 'Pizzas' },
      sortOrder: 1,
    },
  });
  const cat2Boissons2 = await prisma.productCategory.create({
    data: {
      name: { fr: 'Boissons', en: 'Drinks' },
      sortOrder: 2,
    },
  });

  const produits2 = [
    { name: { fr: 'Classic Burger', en: 'Classic Burger' }, price: 3500, cat: cat2Burgers.id, desc: { fr: 'Steak de bœuf, salade, tomate, oignon, sauce maison', en: 'Beef patty, lettuce, tomato, onion, house sauce' } },
    { name: { fr: 'Double Cheese Burger', en: 'Double Cheese Burger' }, price: 4500, cat: cat2Burgers.id, desc: { fr: 'Double steak, double cheddar fondu, cornichons', en: 'Double patty, double melted cheddar, pickles' } },
    { name: { fr: 'Chicken Burger', en: 'Chicken Burger' }, price: 3200, cat: cat2Burgers.id, desc: { fr: 'Poulet grillé, avocat, mayonnaise épicée', en: 'Grilled chicken, avocado, spicy mayo' } },
    { name: { fr: 'Pizza Margherita (M)', en: 'Margherita Pizza (M)' }, price: 4000, cat: cat2Pizzas.id, desc: { fr: 'Tomate, mozzarella, basilic frais', en: 'Tomato, mozzarella, fresh basil' } },
    { name: { fr: 'Pizza Poulet-Champignons (M)', en: 'Chicken-Mushroom Pizza (M)' }, price: 5000, cat: cat2Pizzas.id, desc: { fr: 'Poulet, champignons, fromage, crème', en: 'Chicken, mushrooms, cheese, cream' } },
    { name: { fr: 'Coca-Cola (33cl)', en: 'Coca-Cola (33cl)' }, price: 500, cat: cat2Boissons2.id, desc: { fr: 'Boisson gazeuse fraîche', en: 'Fresh sparkling drink' } },
    { name: { fr: 'Jus de bissap (50cl)', en: 'Bissap juice (50cl)' }, price: 700, cat: cat2Boissons2.id, desc: { fr: 'Jus d\'hibiscus frais et sucré', en: 'Fresh and sweet hibiscus juice' } },
  ];

  for (const p of produits2) {
    await prisma.product.create({
      data: {
        professionalId: restaurant2.id,
        categoryId: p.cat,
        name: p.name,
        description: p.desc,
        price: p.price,
        currency: 'XOF',
        isAvailable: true,
        imageUrl: `https://placehold.co/400x300/e74c3c/white?text=${encodeURIComponent((p.name as any).fr.split(' ')[0])}`,
      },
    });
  }
  console.log(`   → ${produits2.length} produits créés`);

  // ── 3. Utilisateur Professionnel 3 : Épicerie ─────────────────────────────
  const pro3Phone = '+22997111003';
  let pro3User = await prisma.user.findUnique({ where: { phone: pro3Phone } });
  if (!pro3User) {
    pro3User = await prisma.user.create({
      data: {
        phone: pro3Phone,
        phoneCountry: 'BJ',
        name: 'SuperMarché du Quartier',
        firstName: 'Manager',
        role: 'PROFESSIONAL',
        status: 'ACTIVE',
        lang: 'fr',
        countryCode: 'BJ',
        currency: 'XOF',
      },
    });
  }

  let epicerie = await prisma.professional.findUnique({ where: { userId: pro3User.id } });
  if (!epicerie) {
    epicerie = await prisma.professional.create({
      data: {
        userId: pro3User.id,
        businessName: 'SuperMarché du Quartier',
        category: 'GROCERY',
        description: 'Épicerie de proximité — produits frais, conserves, hygiène',
        address: 'Akpakpa, Cotonou',
        city: 'Cotonou',
        country: 'BJ',
        lat: 6.3611,
        lng: 2.4347,
        phone: pro3Phone,
        status: 'VALIDATED',
        isOpen: true,
        deliveryRadiusKm: 5,
        coverImageUrl: 'https://placehold.co/1200x400/27ae60/white?text=SuperMarch%C3%A9+du+Quartier',
        logoUrl: 'https://placehold.co/200x200/27ae60/white?text=SMQ',
        openingHours: {
          lundi:    { open: '07:00', close: '21:00' },
          mardi:    { open: '07:00', close: '21:00' },
          mercredi: { open: '07:00', close: '21:00' },
          jeudi:    { open: '07:00', close: '21:00' },
          vendredi: { open: '07:00', close: '21:00' },
          samedi:   { open: '07:00', close: '22:00' },
          dimanche: { open: '08:00', close: '18:00' },
        },
      },
    });
  }
  console.log(`✅ Épicerie: ${epicerie.businessName} (id: ${epicerie.id})`);

  const cat3Fruits = await prisma.productCategory.create({
    data: {
      name: { fr: 'Fruits & Légumes', en: 'Fruits & Vegetables' },
      sortOrder: 0,
    },
  });
  const cat3Hygiene = await prisma.productCategory.create({
    data: {
      name: { fr: 'Hygiène', en: 'Hygiene' },
      sortOrder: 1,
    },
  });

  const produits3 = [
    { name: { fr: 'Bananes (régime 1kg)', en: 'Bananas (1kg bunch)' }, price: 500, cat: cat3Fruits.id, desc: { fr: 'Bananes fraîches du Bénin', en: 'Fresh Beninese bananas' } },
    { name: { fr: 'Tomates (1kg)', en: 'Tomatoes (1kg)' }, price: 600, cat: cat3Fruits.id, desc: { fr: 'Tomates fraîches', en: 'Fresh tomatoes' } },
    { name: { fr: 'Oignons (1kg)', en: 'Onions (1kg)' }, price: 400, cat: cat3Fruits.id, desc: { fr: 'Oignons locaux', en: 'Local onions' } },
    { name: { fr: 'Savon Lux (pack 3)', en: 'Lux Soap (pack 3)' }, price: 900, cat: cat3Hygiene.id, desc: { fr: 'Pack de 3 savons Lux', en: 'Pack of 3 Lux soaps' } },
    { name: { fr: 'Dentifrice Colgate 75ml', en: 'Colgate toothpaste 75ml' }, price: 700, cat: cat3Hygiene.id, desc: { fr: 'Dentifrice fluoré protection caries', en: 'Fluoride toothpaste, cavity protection' } },
  ];

  for (const p of produits3) {
    await prisma.product.create({
      data: {
        professionalId: epicerie.id,
        categoryId: p.cat,
        name: p.name,
        description: p.desc,
        price: p.price,
        currency: 'XOF',
        isAvailable: true,
        imageUrl: `https://placehold.co/400x300/27ae60/white?text=${encodeURIComponent((p.name as any).fr.split(' ')[0])}`,
      },
    });
  }
  console.log(`   → ${produits3.length} produits créés`);

  // ── Récap ─────────────────────────────────────────────────────────────────
  console.log('\n🎉 Demo seed completed!');
  console.log('');
  console.log('📋 Comptes professionnels créés (se connecter avec OTP) :');
  console.log(`   • ${pro1Phone}  →  Chez Maman Adjovi (Restaurant)`);
  console.log(`   • ${pro2Phone}  →  Burger Palace Cotonou (Restaurant)`);
  console.log(`   • ${pro3Phone}  →  SuperMarché du Quartier (Épicerie)`);
  console.log('');
  console.log('📱 Ces professionnels apparaîtront dans l\'app client (statut VALIDATED + isOpen)');
}

main()
  .catch((e) => { console.error('❌ Demo seed failed:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
