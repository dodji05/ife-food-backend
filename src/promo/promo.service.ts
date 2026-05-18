import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ValidatePromoDto } from './dto/validate-promo.dto';

@Injectable()
export class PromoService {
  constructor(private prisma: PrismaService) {}

  /**
   * Validate-only check d'un code promo (READ-ONLY, n'incrémente pas usesCount).
   *
   * Use case : le client saisit un code dans son panier et clique "Appliquer".
   * On lui retourne immédiatement le discount appliqué (preview), SANS consommer
   * une utilisation. La consommation atomique (UPDATE usesCount + 1) se fait
   * au moment de la création de l'order (cf. orders.service.applyPromoCode).
   *
   * Sans ce endpoint séparé, le code serait consommé à chaque clic "Appliquer"
   * même si le user ne finalise pas la commande -> stock épuisé inutilement.
   *
   * Retourne {valid:false, ...} au lieu de throw pour que le front affiche
   * un message inline propre. Throw uniquement sur erreurs serveur (DB down).
   */
  async validate(dto: ValidatePromoDto, userId: string) {
    const promo = await this.prisma.promoCode.findUnique({ where: { code: dto.code } });

    if (!promo) {
      return { valid: false, discount: 0, message: 'Code promo introuvable' };
    }
    if (!promo.isActive) {
      return { valid: false, discount: 0, message: 'Code promo désactivé' };
    }
    if (promo.expiresAt && new Date() > promo.expiresAt) {
      return { valid: false, discount: 0, message: 'Code promo expiré' };
    }
    if (dto.subtotal < promo.minOrder) {
      return {
        valid: false, discount: 0,
        message: `Commande minimum de ${promo.minOrder.toFixed(0)} F requise (panier : ${dto.subtotal.toFixed(0)} F)`,
      };
    }
    if (promo.maxUses !== null && promo.usesCount >= promo.maxUses) {
      return { valid: false, discount: 0, message: 'Limite d\'utilisations atteinte' };
    }

    // Check per-user : si le code est marqué perUser=true, vérifier dans
    // PromoCodeUsage qu'il n'a pas déjà été utilisé par ce user.
    if (promo.perUser) {
      const alreadyUsed = await this.prisma.promoCodeUsage.findFirst({
        where: { promoCodeId: promo.id, userId },
      });
      if (alreadyUsed) {
        return { valid: false, discount: 0, message: 'Vous avez déjà utilisé ce code' };
      }
    }

    // Calcul du discount selon type (PERCENTAGE / FIXED).
    const discount = promo.type === 'PERCENTAGE'
      ? Math.round(dto.subtotal * (promo.value / 100))
      : promo.value;

    return {
      valid: true,
      discount,
      message: promo.type === 'PERCENTAGE'
          ? `-${promo.value.toFixed(0)} % (${discount.toFixed(0)} F)`
          : `-${discount.toFixed(0)} F`,
    };
  }
}
