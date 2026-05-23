/**
 * seed-orders-bulk.ts — ifè FOOD
 * ─────────────────────────────────────────────────────────────────────────────
 * Génère 45 commandes réalistes réparties sur ~2 mois et demi pour 3 clients
 * dans 2 boutiques. Toutes les relations métier sont respectées :
 *
 *   Distribution statuts :
 *     • 41 DELIVERED        (~91 %)  – paiement SUCCESS, livraison complète
 *     •  3 CANCELLED        (~ 7 %)  – annulées par le client avant paiement
 *     •  1 PENDING_PAYMENT  (~ 2 %)  – en attente de paiement (toute récente)
 *
 *   Par commande DELIVERED, ce script crée :
 *     Order → OrderItems → Payment(SUCCESS) → Delivery(DELIVERED)
 *     → Notification(ORDER_NEW pro, ORDER_ACCEPTED, ORDER_DRIVER_ASSIGNED,
 *                    MISSION_NEW driver, ORDER_IN_DELIVERY, ORDER_DELIVERED)
 *     → Transaction(COMMISSION pro + DELIVERY_FEE driver)
 *     → Transaction(TIP driver) si pourboire
 *     → Review si applicable (~63 % des livrées)
 *
 * Idempotent : tag [BULK-SEED] dans specialInstructions.
 *   Pour repartir de zéro :
 *   DELETE FROM orders WHERE "specialInstructions" LIKE '[BULK-SEED]%'
 *     AND "clientId" IN ('87c82561-…','d3704392-…','30ceaa9b-…');
 *
 * Usage (VPS) :
 *   npm run seed:orders-bulk
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as path from 'node:path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(process.cwd(), '.env') });

import { PrismaClient } from '@prisma/client';
import { PrismaPg }     from '@prisma/adapter-pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL absent — vérifier que le .env existe à la racine du backend.');
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma  = new PrismaClient({ adapter });

// ─── Acteurs ──────────────────────────────────────────────────────────────────
const CLIENT_IDS = [
  '87c82561-5947-4e6a-aef5-0fb365feee38',  // client 0
  'd3704392-1b9b-49a2-bd72-b9e18d831e9f',  // client 1
  '30ceaa9b-74ec-4aa4-9d19-bf534647a612',  // client 2
] as const;

const SHOP_IDS = [
  '443dc40f-8ebc-4b94-9e9e-d4c6accfe6e3',  // shop 0
  '3b4b0e0a-20d7-47da-b999-62257d384755',  // shop 1
] as const;

// Les owners sont récupérés dynamiquement depuis la DB (shop.userId).

const SEED_TAG    = '[BULK-SEED]';
const COMMISSION  = 0.10;          // 10 % de commission plateforme
const CURRENCY    = 'XOF';

// ─── Adresses de livraison — une par client ───────────────────────────────────
const CLIENT_ADDRESSES = [
  { address: "Lot 132, Quartier Cadjehoun, près du carrefour SCOA",          lat: 6.3654, lng: 2.4183, city: 'Cotonou', country: 'BJ' },
  { address: "Villa 58, Haie Vive, derrière l'ambassade des USA",            lat: 6.3721, lng: 2.4022, city: 'Cotonou', country: 'BJ' },
  { address: "Rue 12.148, Quartier Gbèdjromèdé, face pharmacie Saint-Michel",lat: 6.3611, lng: 2.4312, city: 'Cotonou', country: 'BJ' },
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────
/** Construit une Date à N jours en arrière, à l'heure exacte demandée. */
const dateAt = (daysAgo: number, hour: number, minute: number): Date => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d;
};

const addMin = (d: Date, minutes: number): Date =>
  new Date(d.getTime() + minutes * 60_000);

const rand = (min: number, max: number): number =>
  min + Math.floor(Math.random() * (max - min + 1));

const pick = <T>(arr: T[], n: number): T[] =>
  [...arr].sort(() => Math.random() - 0.5).slice(0, Math.min(n, arr.length));

// ─── Définition des 45 commandes ──────────────────────────────────────────────

type OrderStatus = 'DELIVERED' | 'CANCELLED' | 'PENDING_PAYMENT';
type PayMethod   = 'KKIAPAY' | 'CASH_ON_DELIVERY' | 'FEDAPAY';

interface OrderConf {
  daysAgo:    number;
  hour:       number;    // heure du jour (8h-22h)
  minute:     number;    // minute pour éviter les doublons à la même heure
  clientIdx:  0 | 1 | 2;
  shopIdx:    0 | 1;
  payMethod:  PayMethod;
  status:     OrderStatus;
  itemCount:  number;   // nb de produits distincts
  hasTip:     boolean;
  tipAmount:  number;   // 0 si pas de pourboire
  hasReview:  boolean;
  proRating:  number;   // 0 si pas de review
  drvRating:  number;   // 0 si pas de review
  proComment: string;
  drvComment: string;
  cancelNote: string;   // raison annulation (vide si non CANCELLED)
}

// ─── 41 DELIVERED + 3 CANCELLED + 1 PENDING_PAYMENT = 45 ─────────────────────
const ORDERS: OrderConf[] = [
  // ════════════════════════════════════════════════════════════
  //  DELIVERED  (41 commandes)
  //  Environ 1 tous les 1,8 jours sur 75 jours, réparties entre
  //  les 3 clients et les 2 boutiques.
  // ════════════════════════════════════════════════════════════
  { daysAgo:75, hour:12, minute:17, clientIdx:0, shopIdx:0, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:2, hasTip:false, tipAmount:0,    hasReview:true,  proRating:5, drvRating:5, proComment:'Très bonne cuisine, sauce graine excellente !',    drvComment:'Livreur ponctuel et souriant.',                  cancelNote:'' },
  { daysAgo:73, hour:19, minute:42, clientIdx:1, shopIdx:1, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:3, hasTip:false, tipAmount:0,    hasReview:false, proRating:0, drvRating:0, proComment:'',                                                drvComment:'',                                              cancelNote:'' },
  { daysAgo:71, hour:13, minute:8, clientIdx:2, shopIdx:0, payMethod:'CASH_ON_DELIVERY', status:'DELIVERED',       itemCount:1, hasTip:true,  tipAmount:500,  hasReview:true,  proRating:4, drvRating:5, proComment:'Bon repas, légèrement tiède à la livraison.',     drvComment:'Super livreur, a attendu patiemment.',          cancelNote:'' },
  { daysAgo:69, hour:18, minute:33, clientIdx:0, shopIdx:1, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:2, hasTip:false, tipAmount:0,    hasReview:true,  proRating:5, drvRating:4, proComment:'Burger délicieux, pain bien croustillant !',       drvComment:'Rapide et efficace.',                           cancelNote:'' },
  { daysAgo:67, hour:12, minute:55, clientIdx:1, shopIdx:0, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:2, hasTip:false, tipAmount:0,    hasReview:false, proRating:0, drvRating:0, proComment:'',                                                drvComment:'',                                              cancelNote:'' },
  { daysAgo:65, hour:20, minute:11, clientIdx:2, shopIdx:1, payMethod:'FEDAPAY',          status:'DELIVERED',       itemCount:3, hasTip:true,  tipAmount:800,  hasReview:true,  proRating:5, drvRating:5, proComment:'Pizza parfaite, pâte fine comme demandé !',        drvComment:'Excellent livreur, je recommande vivement.',    cancelNote:'' },
  { daysAgo:63, hour:13, minute:27, clientIdx:0, shopIdx:0, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:2, hasTip:false, tipAmount:0,    hasReview:true,  proRating:4, drvRating:4, proComment:'Repas copieux, très bonne quantité.',              drvComment:'Ponctuel et professionnel.',                    cancelNote:'' },
  { daysAgo:61, hour:19, minute:50, clientIdx:1, shopIdx:1, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:1, hasTip:false, tipAmount:0,    hasReview:false, proRating:0, drvRating:0, proComment:'',                                                drvComment:'',                                              cancelNote:'' },
  { daysAgo:59, hour:12, minute:3, clientIdx:2, shopIdx:0, payMethod:'CASH_ON_DELIVERY', status:'DELIVERED',       itemCount:3, hasTip:false, tipAmount:0,    hasReview:true,  proRating:3, drvRating:4, proComment:'Correct mais un peu moins épicé qu\'attendu.',     drvComment:'Correct, légèrement en retard.',                cancelNote:'' },
  { daysAgo:57, hour:14, minute:38, clientIdx:0, shopIdx:1, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:2, hasTip:true,  tipAmount:300,  hasReview:false, proRating:0, drvRating:0, proComment:'',                                                drvComment:'',                                              cancelNote:'' },
  { daysAgo:55, hour:18, minute:22, clientIdx:1, shopIdx:0, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:2, hasTip:false, tipAmount:0,    hasReview:true,  proRating:5, drvRating:5, proComment:'Toujours aussi délicieux ! Client fidèle.',        drvComment:'Parfait comme toujours.',                       cancelNote:'' },
  { daysAgo:53, hour:11, minute:47, clientIdx:2, shopIdx:1, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:4, hasTip:false, tipAmount:0,    hasReview:false, proRating:0, drvRating:0, proComment:'',                                                drvComment:'',                                              cancelNote:'' },
  { daysAgo:51, hour:13, minute:15, clientIdx:0, shopIdx:0, payMethod:'FEDAPAY',          status:'DELIVERED',       itemCount:2, hasTip:false, tipAmount:0,    hasReview:true,  proRating:4, drvRating:3, proComment:'Bonne nourriture mais emballage un peu abîmé.',   drvComment:'Livraison OK, rien à signaler.',                cancelNote:'' },
  { daysAgo:49, hour:19, minute:59, clientIdx:1, shopIdx:1, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:1, hasTip:true,  tipAmount:600,  hasReview:true,  proRating:5, drvRating:5, proComment:'Meilleur burger de Cotonou, sans hésitation !',   drvComment:'Livreur rapide et sympa, mérite le pourboire.', cancelNote:'' },
  { daysAgo:47, hour:20, minute:30, clientIdx:2, shopIdx:0, payMethod:'CASH_ON_DELIVERY', status:'DELIVERED',       itemCount:3, hasTip:false, tipAmount:0,    hasReview:false, proRating:0, drvRating:0, proComment:'',                                                drvComment:'',                                              cancelNote:'' },
  { daysAgo:45, hour:12, minute:44, clientIdx:0, shopIdx:1, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:2, hasTip:false, tipAmount:0,    hasReview:true,  proRating:5, drvRating:4, proComment:'Commande parfaite, rien à redire !',              drvComment:'Efficace et discret.',                          cancelNote:'' },
  { daysAgo:43, hour:18, minute:9, clientIdx:1, shopIdx:0, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:2, hasTip:false, tipAmount:0,    hasReview:false, proRating:0, drvRating:0, proComment:'',                                                drvComment:'',                                              cancelNote:'' },
  { daysAgo:41, hour:19, minute:31, clientIdx:2, shopIdx:1, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:3, hasTip:true,  tipAmount:1000, hasReview:true,  proRating:5, drvRating:5, proComment:'Exceptionnel ! Je commande ici chaque semaine.',  drvComment:'Extraordinaire, toujours souriant et rapide !', cancelNote:'' },
  { daysAgo:39, hour:13, minute:52, clientIdx:0, shopIdx:0, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:2, hasTip:false, tipAmount:0,    hasReview:true,  proRating:4, drvRating:4, proComment:'Bonne portion et qualité constante.',             drvComment:'Livraison dans les temps.',                     cancelNote:'' },
  { daysAgo:37, hour:14, minute:26, clientIdx:1, shopIdx:1, payMethod:'FEDAPAY',          status:'DELIVERED',       itemCount:1, hasTip:false, tipAmount:0,    hasReview:false, proRating:0, drvRating:0, proComment:'',                                                drvComment:'',                                              cancelNote:'' },
  { daysAgo:35, hour:19, minute:7, clientIdx:2, shopIdx:0, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:2, hasTip:false, tipAmount:0,    hasReview:true,  proRating:5, drvRating:5, proComment:'Sauce graine au top, maman Adjovi fait du bon travail !', drvComment:'Super service de livraison.',              cancelNote:'' },
  { daysAgo:33, hour:12, minute:41, clientIdx:0, shopIdx:1, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:3, hasTip:true,  tipAmount:400,  hasReview:false, proRating:0, drvRating:0, proComment:'',                                                drvComment:'',                                              cancelNote:'' },
  { daysAgo:31, hour:13, minute:18, clientIdx:1, shopIdx:0, payMethod:'CASH_ON_DELIVERY', status:'DELIVERED',       itemCount:2, hasTip:false, tipAmount:0,    hasReview:true,  proRating:4, drvRating:4, proComment:'Repas savoureux, conforme à la description.',     drvComment:'Rapide et respectueux.',                        cancelNote:'' },
  { daysAgo:29, hour:18, minute:55, clientIdx:2, shopIdx:1, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:1, hasTip:false, tipAmount:0,    hasReview:true,  proRating:5, drvRating:5, proComment:'Pizza excellente, pâte croustillante parfaite !', drvComment:'Livreur top, commande bien préservée.',         cancelNote:'' },
  { daysAgo:27, hour:19, minute:4, clientIdx:0, shopIdx:0, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:3, hasTip:true,  tipAmount:700,  hasReview:true,  proRating:5, drvRating:5, proComment:'Habitué de la maison, toujours satisfait !',      drvComment:'Excellent service, très ponctuel.',             cancelNote:'' },
  { daysAgo:26, hour:12, minute:36, clientIdx:1, shopIdx:1, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:2, hasTip:false, tipAmount:0,    hasReview:false, proRating:0, drvRating:0, proComment:'',                                                drvComment:'',                                              cancelNote:'' },
  { daysAgo:24, hour:20, minute:13, clientIdx:2, shopIdx:0, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:2, hasTip:false, tipAmount:0,    hasReview:true,  proRating:4, drvRating:4, proComment:'Bonne cuisine béninoise authentique.',            drvComment:'Livraison correcte.',                           cancelNote:'' },
  { daysAgo:22, hour:14, minute:49, clientIdx:0, shopIdx:1, payMethod:'FEDAPAY',          status:'DELIVERED',       itemCount:3, hasTip:false, tipAmount:0,    hasReview:false, proRating:0, drvRating:0, proComment:'',                                                drvComment:'',                                              cancelNote:'' },
  { daysAgo:20, hour:19, minute:22, clientIdx:1, shopIdx:0, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:2, hasTip:false, tipAmount:0,    hasReview:true,  proRating:5, drvRating:5, proComment:'Incroyable ! La meilleure cuisine du coin.',      drvComment:'Parfait, livraison ultra-rapide.',              cancelNote:'' },
  { daysAgo:18, hour:13, minute:5, clientIdx:2, shopIdx:1, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:1, hasTip:true,  tipAmount:500,  hasReview:true,  proRating:5, drvRating:4, proComment:'Burger toujours aussi bon !',                    drvComment:'Bon livreur, discret et efficace.',             cancelNote:'' },
  { daysAgo:16, hour:18, minute:37, clientIdx:0, shopIdx:0, payMethod:'CASH_ON_DELIVERY', status:'DELIVERED',       itemCount:2, hasTip:false, tipAmount:0,    hasReview:false, proRating:0, drvRating:0, proComment:'',                                                drvComment:'',                                              cancelNote:'' },
  { daysAgo:14, hour:12, minute:19, clientIdx:1, shopIdx:1, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:3, hasTip:false, tipAmount:0,    hasReview:true,  proRating:4, drvRating:5, proComment:'Très bonne pizza, bien garnie.',                 drvComment:'Excellent livreur, très ponctuel.',             cancelNote:'' },
  { daysAgo:12, hour:19, minute:48, clientIdx:2, shopIdx:0, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:2, hasTip:true,  tipAmount:800,  hasReview:true,  proRating:5, drvRating:5, proComment:'Meilleure cuisine de Cotonou, sans concurrence !', drvComment:'Toujours un plaisir, merci !',                 cancelNote:'' },
  { daysAgo:10, hour:14, minute:32, clientIdx:0, shopIdx:1, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:1, hasTip:false, tipAmount:0,    hasReview:false, proRating:0, drvRating:0, proComment:'',                                                drvComment:'',                                              cancelNote:'' },
  { daysAgo: 8, hour:13, minute:11, clientIdx:1, shopIdx:0, payMethod:'FEDAPAY',          status:'DELIVERED',       itemCount:3, hasTip:false, tipAmount:0,    hasReview:true,  proRating:5, drvRating:4, proComment:'Ablo braisé exceptionnel comme toujours !',       drvComment:'Livraison rapide, merci.',                      cancelNote:'' },
  { daysAgo: 7, hour:19, minute:44, clientIdx:2, shopIdx:1, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:2, hasTip:false, tipAmount:0,    hasReview:true,  proRating:4, drvRating:4, proComment:'Bonne commande, client satisfait.',              drvComment:'Correct et ponctuel.',                          cancelNote:'' },
  { daysAgo: 6, hour:12, minute:28, clientIdx:0, shopIdx:0, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:2, hasTip:true,  tipAmount:600,  hasReview:false, proRating:0, drvRating:0, proComment:'',                                                drvComment:'',                                              cancelNote:'' },
  { daysAgo: 5, hour:18, minute:3, clientIdx:1, shopIdx:1, payMethod:'CASH_ON_DELIVERY', status:'DELIVERED',       itemCount:1, hasTip:false, tipAmount:0,    hasReview:true,  proRating:5, drvRating:5, proComment:'Classic Burger top qualité !',                   drvComment:'Excellent, livraison parfaite.',                cancelNote:'' },
  { daysAgo: 4, hour:19, minute:56, clientIdx:2, shopIdx:0, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:3, hasTip:false, tipAmount:0,    hasReview:false, proRating:0, drvRating:0, proComment:'',                                                drvComment:'',                                              cancelNote:'' },
  { daysAgo: 3, hour:14, minute:21, clientIdx:0, shopIdx:1, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:2, hasTip:false, tipAmount:0,    hasReview:true,  proRating:5, drvRating:4, proComment:'Très satisfait, je recommande !',               drvComment:'Livraison soignée.',                            cancelNote:'' },
  { daysAgo: 2, hour:20, minute:39, clientIdx:1, shopIdx:0, payMethod:'KKIAPAY',          status:'DELIVERED',       itemCount:2, hasTip:true,  tipAmount:300,  hasReview:true,  proRating:4, drvRating:5, proComment:'Bon repas, légèrement moins épicé ce soir.',    drvComment:'Excellent livreur, très rapide !',              cancelNote:'' },

  // ════════════════════════════════════════════════════════════
  //  CANCELLED  (3 commandes — une par client, ~7 %)
  //  Annulées par le client avant paiement.
  // ════════════════════════════════════════════════════════════
  { daysAgo:70, hour:15, minute:23, clientIdx:2, shopIdx:0, payMethod:'KKIAPAY',  status:'CANCELLED',       itemCount:2, hasTip:false, tipAmount:0, hasReview:false, proRating:0, drvRating:0, proComment:'', drvComment:'', cancelNote:'Changement de plan, commande annulée avant paiement.' },
  { daysAgo:44, hour:10, minute:7, clientIdx:0, shopIdx:1, payMethod:'KKIAPAY',  status:'CANCELLED',       itemCount:1, hasTip:false, tipAmount:0, hasReview:false, proRating:0, drvRating:0, proComment:'', drvComment:'', cancelNote:'Je rentre cuisiner à la maison finalement.'           },
  { daysAgo:25, hour:17, minute:45, clientIdx:1, shopIdx:0, payMethod:'KKIAPAY',  status:'CANCELLED',       itemCount:2, hasTip:false, tipAmount:0, hasReview:false, proRating:0, drvRating:0, proComment:'', drvComment:'', cancelNote:'Double commande par erreur, annulation immédiate.'    },

  // ════════════════════════════════════════════════════════════
  //  PENDING_PAYMENT  (1 commande — toute récente, ~2 %)
  // ════════════════════════════════════════════════════════════
  { daysAgo: 1, hour:11, minute:14, clientIdx:2, shopIdx:1, payMethod:'KKIAPAY',  status:'PENDING_PAYMENT', itemCount:2, hasTip:false, tipAmount:0, hasReview:false, proRating:0, drvRating:0, proComment:'', drvComment:'', cancelNote:'' },
];

// ─── Helpers contenu notifications (français) ─────────────────────────────────
const notifContent = {
  ORDER_NEW:            (shopName: string, total: number) => ({
    title: 'Nouvelle commande !',
    body:  `Un client a passé une commande de ${total.toLocaleString()} F — ${shopName}`,
  }),
  ORDER_ACCEPTED:       (shopName: string) => ({
    title: 'Commande acceptée',
    body:  `${shopName} a accepté votre commande et la prépare.`,
  }),
  ORDER_DRIVER_ASSIGNED: () => ({
    title: 'Livreur en route !',
    body:  'Un livreur a été assigné à votre commande.',
  }),
  MISSION_NEW:          (total: number) => ({
    title: 'Nouvelle mission !',
    body:  `Une livraison de ${total.toLocaleString()} F vous a été assignée.`,
  }),
  ORDER_IN_DELIVERY:    () => ({
    title: 'Livraison en cours',
    body:  'Votre commande est en route. Préparez-vous à recevoir !',
  }),
  ORDER_DELIVERED:      () => ({
    title: 'Commande livrée ! 🎉',
    body:  'Votre commande a bien été livrée. Bon appétit !',
  }),
  ORDER_CANCELLED:      () => ({
    title: 'Commande annulée',
    body:  'Votre commande a été annulée avec succès.',
  }),
};

// ─── Création d'une commande DELIVERED ────────────────────────────────────────
async function createDeliveredOrder(
  conf:        OrderConf,
  clientId:    string,
  shop:        { id: string; businessName: string; userId: string },
  products:    { id: string; price: number }[],
  driver:      { id: string; userId: string },
): Promise<void> {
  // Items
  const selected = pick(products, conf.itemCount);
  const orderItems = selected.map(p => {
    const qty        = rand(1, 2);
    const unitPrice  = p.price;
    const totalPrice = unitPrice * qty;
    return { productId: p.id, quantity: qty, unitPrice, totalPrice };
  });

  const subtotal         = orderItems.reduce((s, i) => s + i.totalPrice, 0);
  const deliveryFee      = rand(700, 1200);
  const tipAmount        = conf.tipAmount;
  const commissionAmount = Math.round(subtotal * COMMISSION);
  const totalAmount      = subtotal + deliveryFee + tipAmount;

  const addr      = CLIENT_ADDRESSES[conf.clientIdx];
  const createdAt = dateAt(conf.daysAgo, conf.hour, conf.minute);

  // Timeline de livraison
  const paymentOkAt      = addMin(createdAt,  3);   // paiement validé
  const driverAssignedAt = addMin(createdAt,  7);   // livreur assigné
  const acceptedAt       = addMin(createdAt, 10);   // commande acceptée par le pro
  const pickupAt         = addMin(createdAt, 35);   // livreur arrive au resto et récupère
  const deliveredAt      = addMin(createdAt, 70);   // livré au client
  const reviewAt         = addMin(deliveredAt, rand(30, 240)); // avis 30min–4h après

  // — Order (avec Payment + Delivery imbriqués) ——————————————
  const order = await prisma.order.create({
    data: {
      clientId:            clientId,
      professionalId:      shop.id,
      driverId:            driver.id,
      status:              'DELIVERED',
      paymentStatus:       'SUCCESS',
      paymentMethod:       conf.payMethod,
      subtotal,
      deliveryFee,
      taxAmount:           0,
      commissionAmount,
      totalAmount,
      tipAmount,
      currency:            CURRENCY,
      deliveryAddress:     addr.address,
      deliveryLat:         addr.lat,
      deliveryLng:         addr.lng,
      deliveryCity:        addr.city,
      deliveryCountry:     addr.country,
      specialInstructions: SEED_TAG,
      estimatedDeliveryMin: 45,
      createdAt,
      updatedAt:           deliveredAt,
      items: { create: orderItems },
      payment: {
        create: {
          gateway:    conf.payMethod,
          amount:     totalAmount,
          currency:   CURRENCY,
          status:     'SUCCESS',
          gatewayRef: `bulk-${Math.random().toString(36).slice(2, 12)}`,
          createdAt,
          updatedAt:  paymentOkAt,
        },
      },
      delivery: {
        create: {
          driverId:      driver.id,
          status:        'DELIVERED',
          pickupTime:    pickupAt,
          deliveredTime: deliveredAt,
          distanceKm:    +(rand(12, 58) / 10).toFixed(1),  // 1.2 – 5.8 km
          driverLat:     addr.lat + (Math.random() - 0.5) * 0.02,
          driverLng:     addr.lng + (Math.random() - 0.5) * 0.02,
          createdAt:     driverAssignedAt,
          updatedAt:     deliveredAt,
        },
      },
    },
    select: { id: true },
  });

  // — Notifications ——————————————————————————————————————————
  // Passées (>7j) : read:true  |  Récentes (≤7j) : read:false
  const isOld = conf.daysAgo > 7;

  await prisma.notification.createMany({ data: [
    // Pro : nouvelle commande
    {
      userId: shop.userId,
      type:   'ORDER_NEW',
      ...notifContent.ORDER_NEW(shop.businessName, totalAmount),
      data:      { orderId: order.id },
      read:      isOld,
      createdAt,
    },
    // Client : commande acceptée
    {
      userId: clientId,
      type:   'ORDER_ACCEPTED',
      ...notifContent.ORDER_ACCEPTED(shop.businessName),
      data:      { orderId: order.id },
      read:      isOld,
      createdAt: acceptedAt,
    },
    // Client : livreur assigné
    {
      userId: clientId,
      type:   'ORDER_DRIVER_ASSIGNED',
      ...notifContent.ORDER_DRIVER_ASSIGNED(),
      data:      { orderId: order.id },
      read:      isOld,
      createdAt: driverAssignedAt,
    },
    // Driver : nouvelle mission
    {
      userId: driver.userId,
      type:   'MISSION_NEW',
      ...notifContent.MISSION_NEW(totalAmount),
      data:      { orderId: order.id },
      read:      isOld,
      createdAt: driverAssignedAt,
    },
    // Client : en cours de livraison
    {
      userId: clientId,
      type:   'ORDER_IN_DELIVERY',
      ...notifContent.ORDER_IN_DELIVERY(),
      data:      { orderId: order.id },
      read:      isOld,
      createdAt: pickupAt,
    },
    // Client : commande livrée
    {
      userId: clientId,
      type:   'ORDER_DELIVERED',
      ...notifContent.ORDER_DELIVERED(),
      data:      { orderId: order.id },
      read:      isOld,
      createdAt: deliveredAt,
    },
  ]});

  // — Transactions ————————————————————————————————————————————
  await prisma.transaction.createMany({ data: [
    {
      professionalId: shop.id,
      orderId:        order.id,
      type:           'COMMISSION',
      amount:         commissionAmount,
      currency:       CURRENCY,
      status:         'COMPLETED',
      description:    `Commission commande #${order.id.slice(0, 8)}`,
      createdAt:      deliveredAt,
    },
    {
      driverId:    driver.id,
      orderId:     order.id,
      type:        'DELIVERY_FEE',
      amount:      deliveryFee,
      currency:    CURRENCY,
      status:      'COMPLETED',
      description: `Frais livraison commande #${order.id.slice(0, 8)}`,
      createdAt:   deliveredAt,
    },
  ]});

  // — Pourboire (si applicable) ————————————————————————————————
  if (conf.hasTip && conf.tipAmount > 0) {
    await prisma.transaction.create({
      data: {
        driverId:    driver.id,
        orderId:     order.id,
        type:        'TIP',
        amount:      conf.tipAmount,
        currency:    CURRENCY,
        status:      'COMPLETED',
        description: `Pourboire commande #${order.id.slice(0, 8)}`,
        createdAt:   addMin(deliveredAt, rand(5, 60)),
      },
    });
  }

  // — Avis (si applicable) ————————————————————————————————————
  if (conf.hasReview && conf.proRating > 0) {
    await prisma.review.create({
      data: {
        orderId:              order.id,
        reviewerId:           clientId,
        professionalId:       shop.id,
        driverId:             driver.id,
        professionalRating:   conf.proRating,
        driverRating:         conf.drvRating,
        professionalComment:  conf.proComment  || null,
        driverComment:        conf.drvComment  || null,
        createdAt:            reviewAt,
      },
    });
  }
}

// ─── Création d'une commande CANCELLED ────────────────────────────────────────
async function createCancelledOrder(
  conf:     OrderConf,
  clientId: string,
  shop:     { id: string; businessName: string; userId: string },
  products: { id: string; price: number }[],
): Promise<void> {
  const selected = pick(products, conf.itemCount);
  const orderItems = selected.map(p => ({
    productId:  p.id,
    quantity:   1,
    unitPrice:  p.price,
    totalPrice: p.price,
  }));

  const subtotal         = orderItems.reduce((s, i) => s + i.totalPrice, 0);
  const deliveryFee      = rand(600, 900);
  const totalAmount      = subtotal + deliveryFee;
  const commissionAmount = Math.round(subtotal * COMMISSION);

  const addr       = CLIENT_ADDRESSES[conf.clientIdx];
  const createdAt  = dateAt(conf.daysAgo, conf.hour, conf.minute);
  const cancelledAt = addMin(createdAt, rand(3, 12)); // annulée 3-12 min après création

  const order = await prisma.order.create({
    data: {
      clientId:            clientId,
      professionalId:      shop.id,
      status:              'CANCELLED',
      paymentStatus:       'PENDING',
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
      specialInstructions: `${SEED_TAG} ${conf.cancelNote}`.trim(),
      estimatedDeliveryMin: 40,
      cancelledBy:         clientId,
      cancelledReason:     conf.cancelNote,
      createdAt,
      updatedAt:           cancelledAt,
      items:   { create: orderItems },
      payment: {
        create: {
          gateway:   conf.payMethod,
          amount:    totalAmount,
          currency:  CURRENCY,
          status:    'PENDING',
          createdAt,
          updatedAt: cancelledAt,
        },
      },
    },
    select: { id: true },
  });

  await prisma.notification.createMany({ data: [
    {
      userId:    shop.userId,
      type:      'ORDER_NEW',
      ...notifContent.ORDER_NEW(shop.businessName, totalAmount),
      data:      { orderId: order.id },
      read:      true,
      createdAt,
    },
    {
      userId:    clientId,
      type:      'ORDER_CANCELLED',
      ...notifContent.ORDER_CANCELLED(),
      data:      { orderId: order.id },
      read:      true,
      createdAt: cancelledAt,
    },
  ]});
}

// ─── Création d'une commande PENDING_PAYMENT ──────────────────────────────────
async function createPendingOrder(
  conf:     OrderConf,
  clientId: string,
  shop:     { id: string },
  products: { id: string; price: number }[],
): Promise<void> {
  const selected = pick(products, conf.itemCount);
  const orderItems = selected.map(p => ({
    productId:  p.id,
    quantity:   1,
    unitPrice:  p.price,
    totalPrice: p.price,
  }));

  const subtotal         = orderItems.reduce((s, i) => s + i.totalPrice, 0);
  const deliveryFee      = rand(700, 1200);
  const totalAmount      = subtotal + deliveryFee;
  const commissionAmount = Math.round(subtotal * COMMISSION);

  const addr      = CLIENT_ADDRESSES[conf.clientIdx];
  const createdAt = dateAt(conf.daysAgo, conf.hour, conf.minute);

  await prisma.order.create({
    data: {
      clientId:            clientId,
      professionalId:      shop.id,
      status:              'PENDING_PAYMENT',
      paymentStatus:       'PENDING',
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
      updatedAt:           createdAt,
      items:   { create: orderItems },
      payment: {
        create: {
          gateway:   conf.payMethod,
          amount:    totalAmount,
          currency:  CURRENCY,
          status:    'PENDING',
          createdAt,
          updatedAt: createdAt,
        },
      },
    },
  });
}

// ─── Entrée principale ────────────────────────────────────────────────────────
async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ifè FOOD — Seed bulk orders (45 commandes / 2,5 mois)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // ─── 1. Vérifications d'existence ──────────────────────────────────────────
  console.log('1/5  Vérification des acteurs…');

  const [clients, shops] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...CLIENT_IDS] } }, select: { id: true, firstName: true, name: true, phone: true, role: true } }),
    prisma.professional.findMany({ where: { id: { in: [...SHOP_IDS] } }, select: { id: true, businessName: true, status: true, userId: true, commissionRate: true } }),
  ]);

  if (clients.length !== CLIENT_IDS.length) {
    const found = clients.map(c => c.id);
    const missing = CLIENT_IDS.filter(id => !found.includes(id));
    throw new Error(`Client(s) introuvable(s) : ${missing.join(', ')}`);
  }
  if (shops.length !== SHOP_IDS.length) {
    const found = shops.map(s => s.id);
    const missing = SHOP_IDS.filter(id => !found.includes(id));
    throw new Error(`Boutique(s) introuvable(s) : ${missing.join(', ')}`);
  }

  for (const c of clients) {
    if (c.role !== 'CLIENT') throw new Error(`Utilisateur ${c.id} a le rôle ${c.role} (attendu CLIENT)`);
  }
  for (const s of shops) {
    if (s.status !== 'VALIDATED') throw new Error(`Boutique ${s.businessName} a le statut ${s.status} (attendu VALIDATED)`);
  }

  clients.forEach(c => {
    const label = [c.firstName, c.name].filter(Boolean).join(' ') || c.phone;
    console.log(`   ✓ Client  : ${label} (${c.id.slice(0, 8)}…)`);
  });
  shops.forEach(s =>
    console.log(`   ✓ Boutique: ${s.businessName} (owner ${s.userId.slice(0, 8)}…)`)
  );

  // ─── 2. Produits disponibles ────────────────────────────────────────────────
  console.log('2/5  Chargement des produits…');
  const productsByShop: Array<{ id: string; price: number }[]> = [];

  for (const shop of shops) {
    const prods = await prisma.product.findMany({
      where: { professionalId: shop.id, isAvailable: true },
      select: { id: true, price: true },
    });
    if (prods.length === 0) {
      throw new Error(`Aucun produit disponible chez ${shop.businessName} — impossible de générer des commandes`);
    }
    productsByShop.push(prods);
    console.log(`   ✓ ${prods.length} produit(s) chez ${shop.businessName}`);
  }

  // ─── 3. Livreurs disponibles ────────────────────────────────────────────────
  console.log('\n3/5  Chargement des livreurs…');
  const drivers = await prisma.driver.findMany({
    where: { status: { in: ['VALIDATED', 'ONLINE', 'OFFLINE'] } },
    select: { id: true, userId: true, status: true, user: { select: { firstName: true, name: true, phone: true } } },
  });

  if (drivers.length === 0) {
    throw new Error('Aucun livreur validé/disponible en base — impossible de générer des livraisons');
  }
  console.log(`   ✓ ${drivers.length} livreur(s) trouvé(s)\n`);

  // ─── 4. Idempotence ─────────────────────────────────────────────────────────
  console.log('4/5  Vérification idempotence…');
  const existing = await prisma.order.count({
    where: {
      specialInstructions: { contains: SEED_TAG },
      clientId: { in: [...CLIENT_IDS] },
    },
  });

  if (existing > 0) {
    console.log(`\n⚠️  ${existing} commande(s) [BULK-SEED] déjà présente(s). Script non rejoué.`);
    console.log('   Pour relancer, supprimer d\'abord les commandes existantes :');
    console.log(`   DELETE FROM orders WHERE "specialInstructions" LIKE '${SEED_TAG}%'`);
    console.log(`     AND "clientId" IN ('${CLIENT_IDS.join("','")}');\n`);
    return;
  }
  console.log('   ✓ Aucune commande bulk existante\n');

  // ─── 5. Création des 45 commandes ──────────────────────────────────────────
  console.log('5/5  Création des commandes…\n');

  const clientById = Object.fromEntries(clients.map(c => [c.id, c]));
  const shopByIdx  = shops; // shops[0] = SHOP_IDS[0], shops[1] = SHOP_IDS[1]

  let cntDelivered = 0, cntCancelled = 0, cntPending = 0, cntTips = 0, cntReviews = 0;

  for (const conf of ORDERS) {
    const clientId = CLIENT_IDS[conf.clientIdx];
    const shop     = shopByIdx[conf.shopIdx];
    const products = productsByShop[conf.shopIdx];
    // Rotation circulaire parmi les livreurs disponibles (déterministe selon l'index)
    const driver   = drivers[ORDERS.indexOf(conf) % drivers.length];

    process.stdout.write(
      `  [${String(ORDERS.indexOf(conf) + 1).padStart(2, '0')}/45]  ` +
      `J-${String(conf.daysAgo).padStart(2, '0')}  ` +
      `${conf.status.padEnd(17)} client:${conf.clientIdx}  shop:${conf.shopIdx}  `
    );

    try {
      switch (conf.status) {
        case 'DELIVERED':
          await createDeliveredOrder(conf, clientId, shop, products, driver);
          cntDelivered++;
          if (conf.hasTip)    cntTips++;
          if (conf.hasReview) cntReviews++;
          console.log(`✓  tip:${conf.hasTip ? conf.tipAmount + ' F' : ' -  '}  review:${conf.hasReview ? '⭐'.repeat(conf.proRating) : '-'}`);
          break;

        case 'CANCELLED':
          await createCancelledOrder(conf, clientId, shop, products);
          cntCancelled++;
          console.log('✓  annulée');
          break;

        case 'PENDING_PAYMENT':
          await createPendingOrder(conf, clientId, shop, products);
          cntPending++;
          console.log('✓  en attente paiement');
          break;
      }
    } catch (err) {
      console.log('\n');
      throw err;
    }
  }

  // ─── Récapitulatif ─────────────────────────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ✅ Seed terminé avec succès');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Commandes créées : ${ORDERS.length}`);
  console.log(`    DELIVERED      : ${cntDelivered}  (~${Math.round(cntDelivered / ORDERS.length * 100)} %)`);
  console.log(`    CANCELLED      : ${cntCancelled}  (~${Math.round(cntCancelled / ORDERS.length * 100)} %)`);
  console.log(`    PENDING_PAYMENT: ${cntPending}  (~${Math.round(cntPending / ORDERS.length * 100)} %)`);
  console.log(`  Pourboires       : ${cntTips}`);
  console.log(`  Avis clients     : ${cntReviews}`);
  console.log(`  Paiements        : ${ORDERS.length}  (un par commande)`);
  console.log(`  Livraisons       : ${cntDelivered}  (une par commande livrée)`);
  console.log(`  Notifications    : ~${cntDelivered * 6 + cntCancelled * 2}`);
  console.log(`  Transactions     : ~${cntDelivered * 2 + cntTips}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main()
  .catch(e => {
    console.error('\n✗ Erreur :', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
