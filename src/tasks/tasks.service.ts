import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import axios from 'axios';
import { computeIsOpen } from '../common/utils/opening-hours.util';

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(private prisma: PrismaService, private config: ConfigService) {}

  /** Refresh exchange rates every 6 hours (cron) */
  @Cron('0 */6 * * *')
  async refreshExchangeRates() {
    // Mode cron : on avale les erreurs pour ne pas crasher le scheduler
    await this._doRefreshExchangeRates(false);
  }

  /**
   * Exécute le refresh des taux de change.
   * @param throwOnError  true = propage l'erreur (appel manuel depuis le controller)
   *                      false = catch silencieux (cron)
   */
  async triggerManualRefresh() {
    await this._doRefreshExchangeRates(true);
  }

  private async _doRefreshExchangeRates(throwOnError: boolean) {
    this.logger.log('🔄 Refreshing exchange rates...');

    // Clé + URL : priorité config admin (DB), fallback .env.
    const cfg = await this.prisma.platformConfig.findUnique({ where: { key: 'exchangeRateCredentials' } });
    const raw = (cfg?.value as any) ?? {};
    const apiKey = (raw.apiKey || this.config.get('EXCHANGE_RATE_API_KEY') || '').trim();
    // Normalisation : supprime les slashes finaux pour éviter les doubles slashes dans l'URL
    const apiUrl = (raw.apiUrl || this.config.get('EXCHANGE_RATE_API_URL', 'https://v6.exchangerate-api.com/v6') || '')
      .trim()
      .replace(/\/+$/, '');

    // Clé absente ou placeholder → erreur explicite en mode manuel, silencieux en cron
    if (!apiKey || apiKey.includes('your_') || apiKey.length < 10) {
      if (throwOnError) throw new Error('Clé API manquante ou invalide (longueur < 10)');
      return;
    }

    // Log de l'URL réelle (clé masquée) pour faciliter le diagnostic
    const maskedKey = apiKey.length > 8 ? `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}` : '****';
    this.logger.log(`📡 Calling: ${apiUrl}/${maskedKey}/latest/XOF (+ 3 autres bases)`);

    try {
      // Devises cibles explicites : paires utiles pour la diaspora + Afrique de l'Ouest.
      // On ne fait PAS de slice(0, 20) — conversion_rates est trié alphabétiquement
      // et les devises importantes (EUR, USD, GBP…) seraient hors des 20 premières.
      const TARGET_CURRENCIES = ['XOF', 'EUR', 'USD', 'GBP', 'CAD', 'CHF', 'MAD', 'DZD', 'TND', 'NGN', 'GHS', 'XAF'];
      const baseCurrencies = ['XOF', 'EUR', 'USD', 'GBP'];

      for (const base of baseCurrencies) {
        const { data } = await axios.get(`${apiUrl}/${apiKey}/latest/${base}`);
        // exchangerate-api.com renvoie { result: 'error', ... } avec HTTP 200 pour une mauvaise clé
        if (data.result === 'error') {
          throw new Error(`API error: ${data['error-type'] ?? data.result}`);
        }
        const rates = data.conversion_rates as Record<string, number>;
        for (const to of TARGET_CURRENCIES) {
          if (to === base || !(to in rates)) continue;
          const rate = rates[to];
          await this.prisma.exchangeRate.upsert({
            where: { fromCurrency_toCurrency: { fromCurrency: base, toCurrency: to } },
            update: { rate },
            create: { fromCurrency: base, toCurrency: to, rate },
          });
        }
      }
      this.logger.log('✅ Exchange rates refreshed');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Exchange rate refresh failed: ${msg}`);
      if (throwOnError) {
        // Enrichir le message pour l'affichage frontend
        const friendly = msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')
          ? `Impossible de joindre l'API de taux de change (erreur réseau : ${msg})`
          : msg.startsWith('API error:')
            ? `Erreur API exchangerate : ${msg.replace('API error: ', '')}`
            : msg;
        throw new Error(friendly);
      }
    }
  }

  /** Clean expired OTP sessions every 30 minutes */
  @Cron('*/30 * * * *')
  async cleanExpiredOtps() {
    const { count } = await this.prisma.otpSession.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (count > 0) this.logger.log(`🗑️  Deleted ${count} expired OTP sessions`);
  }

  /** Sync DB isOpen flag with current opening hours (runs every hour) */
  @Cron(CronExpression.EVERY_HOUR)
  async autoManageProfessionalStatus() {
    const professionals = await this.prisma.professional.findMany({
      where: { status: 'VALIDATED', openingHours: { not: null } },
    });

    let updated = 0;
    for (const prof of professionals) {
      const shouldBeOpen = computeIsOpen(prof.isOpen, prof.openingHours);
      if (prof.isOpen !== shouldBeOpen) {
        await this.prisma.professional.update({
          where: { id: prof.id },
          data: { isOpen: shouldBeOpen },
        });
        updated++;
      }
    }
    if (updated > 0) this.logger.log(`🕒  isOpen updated for ${updated} professional(s)`);
  }

  /** Mark stuck orders as cancelled after 2 hours */
  @Cron('0 */2 * * *')
  async autoResolveStuckOrders() {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const { count } = await this.prisma.order.updateMany({
      where: {
        status: { in: ['PENDING_PAYMENT'] },
        createdAt: { lt: twoHoursAgo },
      },
      data: { status: 'CANCELLED', cancelledReason: 'Payment timeout' },
    });
    if (count > 0) this.logger.log(`⚠️  Auto-cancelled ${count} timed-out orders`);
  }

  /** Clean old login logs (keep 90 days) */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async cleanOldLoginLogs() {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.loginLog.deleteMany({
      where: { createdAt: { lt: ninetyDaysAgo } },
    });
    if (count > 0) this.logger.log(`🗑️  Deleted ${count} old login logs`);
  }

  /** Generate daily revenue report (stored in config) */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async generateDailyReport() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    const endOfYesterday = new Date(yesterday);
    endOfYesterday.setHours(23, 59, 59, 999);

    const [orders, revenue, commissions, newUsers] = await Promise.all([
      this.prisma.order.count({ where: { createdAt: { gte: yesterday, lte: endOfYesterday } } }),
      this.prisma.order.aggregate({ where: { createdAt: { gte: yesterday, lte: endOfYesterday }, status: 'DELIVERED' }, _sum: { totalAmount: true } }),
      this.prisma.transaction.aggregate({ where: { type: 'COMMISSION', createdAt: { gte: yesterday, lte: endOfYesterday } }, _sum: { amount: true } }),
      this.prisma.user.count({ where: { createdAt: { gte: yesterday, lte: endOfYesterday } } }),
    ]);

    const report = {
      date: yesterday.toISOString().split('T')[0],
      orders,
      revenue: revenue._sum.totalAmount ?? 0,
      commissions: commissions._sum.amount ?? 0,
      newUsers,
      generatedAt: new Date().toISOString(),
    };

    await this.prisma.platformConfig.upsert({
      where: { key: `daily_report_${report.date}` },
      update: { value: report },
      create: { key: `daily_report_${report.date}`, value: report },
    });

    this.logger.log(`📊 Daily report generated: ${JSON.stringify(report)}`);
  }
}
