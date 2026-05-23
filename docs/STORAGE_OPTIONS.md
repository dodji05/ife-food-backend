# Stockage des images — Options à arbitrer

> **Status** : en attente de décision. Discussion du 2026-05-19.
> Pour l'instant : Cloudinary en place (placeholder API key sur VPS à corriger).

## Contexte

Actuellement les images (avatars users, logos pros, photos catalogue, documents drivers, preuve livraison) sont uploadées sur **Cloudinary** via `src/cloudinary/cloudinary.service.ts`. Question : peut-on tout stocker directement sur le VPS pour éviter Cloudinary ?

**Réponse courte** : oui, totalement faisable.

---

## Option A — VPS local (simple)

- **Stockage** : `/home/debian/PROJETS/Mouka/uploads/` (dossier sur le VPS)
- **Service** : NestJS sert les fichiers statiques via `ServeStaticModule` OU Nginx
- **URL retournée** : `https://<ton-domaine>/uploads/avatars/abc123.jpg`

### Avantages
- Aucun coût Cloudinary
- Données chez soi (RGPD/contrôle)
- Pas de limite externe (que le disque VPS)
- Simple à implémenter (~2h)

### Inconvénients
- Pas de CDN → users hors Bénin = plus lent (~300ms vs ~30ms)
- Pas de resize/format auto (upload 5MB photo iPhone = 5MB stockée)
- Backup à gérer manuellement
- Si VPS crash = images down
- Espace disque limité (à monitorer)

---

## Option B — VPS + Sharp (resize côté backend) — **RECOMMANDÉE**

Même chose qu'A, mais on resize/compresse au moment de l'upload avec [`sharp`](https://sharp.pixelplumbing.com/) (lib Node ultra rapide).

### Avantages
- Compromis CDN/coût
- Images optimisées (avatar 5MB → 80KB en WebP)
- Génère plusieurs tailles (thumb 100px / medium 400px / large 1024px)

### Effort supplémentaire vs A
- +2h pour sharp + variantes

---

## Option C — Hybride

- Avatars/docs : VPS (peu volumineux, low traffic)
- Photos produits resto : Cloudinary (besoin transformations, CDN, performance)

---

## Recommandation

Pour le stade actuel (early stage Bénin, trafic local) → **Option B (VPS + sharp)**

- 80% du trafic local → CDN pas critique
- Pas de coût récurrent
- Images optimisées = bande passante mobile préservée (important en Afrique de l'Ouest où 4G chère)
- Migration vers Cloudinary plus tard si scale international

---

## Plan d'implémentation Option B (quand on y reviendra)

1. **Backend** :
   - Remplacer `cloudinary.service.ts` par `LocalStorageService`
   - Multer config pour multipart/form-data (déjà supporté NestJS)
   - Resize via `sharp` (3 variantes thumb/medium/original)
   - Storage dans `uploads/<category>/<uuid>.<ext>`
   - Endpoint static `/uploads/*` via `ServeStaticModule`

2. **Migration** :
   - Laisser les URLs Cloudinary existantes fonctionner (ne pas migrer rétroactivement)
   - Les nouvelles uploads vont sur VPS

3. **Contrat API inchangé** :
   - Le mobile reçoit toujours `{ url: '...' }`
   - **Zéro changement côté Flutter**

4. **Effort** : 2-3h, ~3 fichiers backend modifiés.

## Fichiers concernés (référence)

- `src/cloudinary/cloudinary.service.ts` — à remplacer
- `src/cloudinary/cloudinary.module.ts` — à renommer en `storage.module.ts`
- `src/auth/auth.service.ts` ligne ~150 — appel uploadAvatar
- `src/professionals/professionals.service.ts` — upload logo/cover
- `src/products/products.service.ts` — upload images produits
- `src/main.ts` — ajouter ServeStaticModule

## Détails supplémentaires à voir le moment venu

- Limite taille upload (à fixer ~5MB par défaut)
- Whitelist mime types (jpeg/png/webp)
- Validation côté backend (ne pas se fier au content-type client)
- Backup rsync nightly vers un cold storage (Hetzner Storage Box ~5€/mois)
- Monitoring espace disque (`df -h /home`) + alerte > 80%
- Path traversal protection (`uuid` filenames, jamais le nom user)
