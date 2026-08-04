# CLAUDE.md

Ce fichier guide Claude Code (claude.ai/code) dans la gestion du code de ce dépôt.

## Vue d'ensemble

Backend API pour **ifè FOOD** — plateforme de livraison de nourriture pour le Bénin. Stack : **NestJS 10** · **PostgreSQL 14+** · **Prisma ORM** · **Redis** · **Socket.io**.

Dépôt adjacent : frontend web (Angular à localhost:4200), app mobile (Flutter/React Native).

## Démarrage rapide

### Prérequis
- Node.js >= 18
- PostgreSQL >= 14 (avec PostGIS optionnel pour la géolocalisation)
- Redis >= 6
- Variables .env complètes (voir `cp .env.example .env` si absent)

### Installation et lancement
```bash
npm install
npm run prisma:generate        # Générer le client Prisma
npm run prisma:migrate         # Appliquer les migrations
npm run prisma:seed            # Seed initial (optionnel)
npm run start:dev              # Lancer en mode watch
# API sur http://localhost:3000/api/v1
# Swagger sur http://localhost:3000/api/docs
```

## Commandes développement

| Commande | Effet |
|----------|-------|
| `npm run build` | Compiler le TypeScript → dist/ |
| `npm run start` | Démarrer le serveur compilé |
| `npm run start:dev` | Démarrer en mode watch (mode dev) |
| `npm run start:debug` | Démarrer avec débogueur Node attaché |
| `npm run lint` | Linter + corriger automatiquement |
| `npm run format` | Formater (Prettier) |
| `npm run test` | Lancer une fois les tests unitaires |
| `npm run test:watch` | Watcher tests (rejeu auto) |
| `npm run test:cov` | Tests + couverture de code |
| `npm run test:e2e` | Tests e2e (config: `test/jest-e2e.json`) |

## Commandes Prisma

| Commande | Effet |
|----------|-------|
| `npm run prisma:generate` | Régénérer le client après modifs du schema |
| `npm run prisma:migrate` | Créer une migration (`prisma migrate dev --name <name>`) |
| `npm run prisma:studio` | Interface web Prisma Studio (port 5555) |
| `npm run prisma:seed` | Exécuter seed.ts (données de test) |
| `npm run seed:admin` | Créer un compte admin de test |
| `npm run seed:demo-orders` | Créer des commandes pour démo |
| `npm run seed:orders-bulk` | Seeder en masse |
| `npm run seed:active-orders` | Créer des commandes en état "actif" |

**Flux typique après `git pull`** :
```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run start:dev
```

## Architecture modulaire

Tous les modules sont dans `src/` avec structure `module/[*.controller.ts, *.service.ts, *.module.ts]` :

- **auth/** — Authentification OTP (SMS/WhatsApp) + PIN + JWT + 2FA
- **users/** — Profils utilisateurs finaux
- **professionals/** — Restaurants/commerces partenaires
- **drivers/** — Livreurs (gestion zones, horaires)
- **products/** — Catalogue (multilingue : fr/en/es/de/ru/ar/zh)
- **orders/** — Gestion complète des commandes (statuts, annulation, remboursement)
- **payments/** — Stripe, PayPal, KKiaPay, FedaPay + webhooks
- **deliveries/** — Suivi GPS temps réel (WebSocket `/tracking`)
- **reviews/** — Avis et notes (utilisateurs → commerces/livreurs)
- **notifications/** — Push FCM (Firebase Cloud Messaging)
- **messages/** — Chat in-app (WebSocket `/messages`)
- **admin/** — Back-office (modération, config, rapports)
- **geo/** — Géolocalisation, calcul des frais de livraison, zones
- **uploads/** — Stockage local disque des fichiers (images produits/avatars, redimensionnement + conversion WebP via sharp)
- **config/** — Pages légales (CG, confidentialité), bannières
- **tasks/** — Cron jobs asynchrones (Bull + Redis)
- **search/** — Elasticsearch ou recherche full-text PostgreSQL
- **user-addresses/** — Adresses sauvegardées des utilisateurs
- **promo/** — Codes promo, réductions
- **common/** — Guards, pipes, filters, interceptors partagés (JWT, role-based, etc.)
- **prisma/** — Module Prisma (injection du client PrismaClient)

## Configuration clé (main.ts)

- **Versioning** : URI-based (`/api/v1/...`) avec défaut version 1
- **CORS** : Whitelist d'origins (voir `FRONTEND_URL` .env) + requêtes sans origin autorisées (mobile native, server-to-server)
- **Security** : Helmet, rate limiting (ThrottlerModule)
- **Global pipes** : ValidationPipe + whitelist strict + transform implicite
- **WebSocket** : Socket.io activé (namespaces `/tracking`, `/messages`)
- **Swagger** : Auto-généré sauf en production
- **rawBody** : Essentiel pour valider les signatures HMAC webhook (FedaPay, Stripe)
- **Fichiers statiques** : Uploadés servis sur `/uploads/**`

## Infrastructure

**Services externes (variables .env) :**
- **Twilio / WhatsApp** — OTP par SMS ou WhatsApp Business
- **Firebase** — Notifications push
- **Stripe, PayPal** — Paiements internationaux
- **KKiaPay, FedaPay** — Paiements Afrique francophone
- **SendGrid / Nodemailer** — Emails

**Jobs asynchrones (Bull + Redis)** :
- Toutes les 6h : mise à jour taux de change
- Toutes les 30min : cleanup OTP expirés
- Toutes les heures : ouverture/fermeture auto établissements, annulation timeouts
- Chaque nuit 2h : cleanup logs connexion
- Chaque minuit : rapport financier journalier

## Authentification & Autorisation

**Stratégies Passport** : JWT + Local (PIN)

**Rôles** : `USER`, `PROFESSIONAL`, `DRIVER`, `ADMIN`

**Guards** : `@UseGuards(JwtAuthGuard)` ou `@UseGuards(RolesGuard)` avec `@Roles(Role.ADMIN)`

**Tokens JWT** :
- `access_token` : 7 jours
- `refresh_token` : 30 jours
- Min 32 caractères hexadécimaux (voir `JWT_SECRET` .env)

## Tests

Tests unitaires avec Jest + ts-jest. Convention : `*.spec.ts` dans le même dossier que le fichier testé.

**Exemple lancer un test spécifique** :
```bash
npm run test -- --testNamePattern="description du test"
npm run test -- src/auth/auth.service.spec.ts
npm run test:watch -- src/users
```

**E2E** : config séparée (`test/jest-e2e.json`), supertest pour les requêtes HTTP.

## Path aliases TypeScript

Configurés dans `tsconfig.json` pour éviter les imports relatifs :
```typescript
@/*        → src/*
@auth/*    → src/auth/*
@users/*   → src/users/*
@common/*  → src/common/*
@config/*  → src/config/*
```

## Modèle de commission

Admin configure deux modes :
- **PERCENTAGE** : pourcentage sur sous-total (ex: 15%)
- **FIXED_AMOUNT** : montant fixe intégré au prix produit

Peut varier par professionnel, période, zone géographique.

## Conventions de code

- Langage métier en **français** (variables, commentaires, noms métier)
- Code source en **anglais** (noms variables/fonctions, selon convention NestJS)
- Chaque module auto-contenu (controller, service, module, DTOs, entities)
- Services injectables, pas de logique dans contrôleurs
- DTOs pour validation + Swagger (`class-validator`, `class-transformer`)
- Filtres d'exception globaux (`HttpExceptionFilter`)
- Décorateurs pour access control (`@Roles()`, `@Public()`)
- Logging via NestJS built-in logger (Sentry en production optionnel)

## Environnements

- **development** : Swagger actif, logs verbeux, hot-reload
- **production** : Swagger désactivé, variables checks, rawBody pour webhooks, FRONTEND_URL obligatoire

## Antipatterns à éviter

Voir `.claude/rules/antipatterns.md` :
- Pas de pagination offset (→ cursor-based)
- Pas de validation JWT manuelle (→ Passport guard)
- Mots de passe : bcrypt/argon2 obligatoire
- Pas de state global mutable
- Ops fichiers : async obligatoire
- N+1 queries : eager load via Prisma includes
- Real-time : SSE/WebSocket, jamais polling
