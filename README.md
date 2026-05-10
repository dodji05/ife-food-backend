# ifè FOOD — Back-end API

> Plateforme de livraison — Ets SWK FAKEYE, Bénin  
> Stack : **NestJS** · **PostgreSQL** · **Prisma** · **Redis** · **Socket.io** · **Cloudinary**

---

## 🚀 Démarrage rapide

### 1. Prérequis
```bash
Node.js >= 18
PostgreSQL >= 14
Redis >= 6
```

### 2. Installation
```bash
git clone <repo>
cd ife-food-backend

cp .env.example .env
# Remplir toutes les variables dans .env

npm install
npx prisma generate
npx prisma migrate dev --name init
npx ts-node prisma/seed.ts
npm run start:dev
```

### 3. Documentation Swagger
```
http://localhost:3000/api/docs
```

---

## 📁 Architecture

```
src/
├── auth/           # Auth OTP + PIN + 2FA
├── users/          # Profils utilisateurs
├── professionals/  # Établissements partenaires
├── drivers/        # Livreurs
├── products/       # Catalogue produits (multilingue)
├── orders/         # Gestion des commandes
├── payments/       # Stripe, PayPal, KKiaPay, FedaPay
├── deliveries/     # Suivi GPS (WebSocket)
├── reviews/        # Avis et notes
├── notifications/  # Push FCM
├── messages/       # Chat in-app (WebSocket)
├── admin/          # Back-office admin
├── geo/            # Géolocalisation, frais livraison
├── uploads/        # Cloudinary
├── config/         # Pages légales, bannières
└── tasks/          # Cron jobs (Redis)
```

---

## 🔌 Endpoints Clés

### Auth
| Méthode | Route | Description |
|---------|-------|-------------|
| POST | /api/v1/auth/otp/send | Envoyer un OTP |
| POST | /api/v1/auth/otp/verify | Vérifier OTP → JWT |
| POST | /api/v1/auth/pin/verify | Login par PIN |
| POST | /api/v1/auth/pin/set | Définir un PIN |

### Commandes
| Méthode | Route | Description |
|---------|-------|-------------|
| POST | /api/v1/orders | Créer une commande |
| GET | /api/v1/orders/my-orders | Historique client |
| GET | /api/v1/orders/professional | Commandes pro |
| PATCH | /api/v1/orders/:id/status | Mettre à jour le statut |
| POST | /api/v1/orders/:id/cancel | Annuler |

### Paiements
| Méthode | Route | Description |
|---------|-------|-------------|
| POST | /api/v1/payments/:orderId/initiate/:gateway | Initier un paiement |
| POST | /api/v1/payments/webhooks/:gateway | Webhooks gateway |

### WebSockets
| Namespace | Event | Description |
|-----------|-------|-------------|
| /tracking | driver_location | Position GPS temps réel |
| /tracking | track_order | Rejoindre une room commande |
| /messages | send | Envoyer un message |
| /messages | join | Rejoindre une conversation |

---

## 💳 Passerelles de paiement

| Gateway | Zone | Status |
|---------|------|--------|
| Stripe | International | ✅ Complet |
| PayPal | International | ✅ Complet |
| KKiaPay | Bénin + Afrique francophone | ✅ Complet |
| FedaPay | Bénin + Afrique francophone | 🔄 Pattern KKiaPay à dupliquer |

---

## 🌍 Multilingue
Produits et pages légales disponibles en : **fr · en · es · de · ru · ar · zh**

---

## ⚙️ Variables d'environnement

Copier `.env.example` → `.env` et remplir :
- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — clé JWT (min 32 chars)
- `TWILIO_*` ou `WHATSAPP_*` — canal OTP (configurer `OTP_CHANNEL=SMS|WHATSAPP`)
- `FIREBASE_*` — notifications push
- `STRIPE_SECRET_KEY` — paiements internationaux
- `KKIAPAY_*` — paiements Afrique francophone
- `CLOUDINARY_*` — stockage fichiers

---

## 🕐 Cron Jobs automatiques

| Fréquence | Tâche |
|-----------|-------|
| Toutes les 6h | Mise à jour des taux de change |
| Toutes les 30min | Nettoyage OTP expirés |
| Toutes les heures | Ouverture/fermeture auto des établissements |
| Toutes les 2h | Annulation des commandes en timeout |
| Chaque nuit à 2h | Nettoyage logs de connexion |
| Chaque nuit à minuit | Rapport financier journalier |

---

## 📊 Modèle de commission

Deux modes configurables via l'admin :
- **PERCENTAGE** : % sur le sous-total (ex: 15%)
- **FIXED_AMOUNT** : montant fixe intégré dans le prix produit à la création

---

## 📞 Contact
- **Société** : Ets SWK FAKEYE
- **Plateforme** : www.ifefood.bj
- **Contact** : gildas31@gmail.com
