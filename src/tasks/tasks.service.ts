import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import axios from 'axios';

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(private prisma: PrismaService, private config: ConfigService) {}

  /** Refresh exchange rates every 6 hours */
  @Cron('0 */6 * * *')
  async refreshExchangeRates() {
    this.logger.log('🔄 Refreshing exchange rates...');
    try {
      // Clé + URL : priorité config admin (DB), fallback .env.
      const cfg = await this.prisma.platformConfig.findUnique({ where: { key: 'exchangeRateCredentials' } });
      const raw = (cfg?.value as any) ?? {};
      const apiKey = raw.apiKey || this.config.get('EXCHANGE_RATE_API_KEY');
      const apiUrl = raw.apiUrl || this.config.get('EXCHANGE_RATE_API_URL', 'https://v6.exchangerate-api.com/v6');
      // Ignorer si la clé est absente ou contient encore la valeur placeholder
      if (!apiKey || apiKey.includes('your_') || apiKey.length < 10) return;

      const baseCurrencies = ['XOF', 'EUR', 'USD', 'GBP'];
      for (const base of baseCurrencies) {
        const { data } = await axios.get(
          `${apiUrl}/${apiKey}/latest/${base}`
        );
        const targets = Object.entries(data.conversion_rates) as [string, number][];
        for (const [to, rate] of targets.slice(0, 20)) {
          await this.prisma.exchangeRate.upsert({
            where: { fromCurrency_toCurrency: { fromCurrency: base, toCurrency: to } },
            update: { rate },
            create: { fromCurrency: base, toCurrency: to, rate },
          });
        }
      }
      this.logger.log('✅ Exchange rates refreshed');
    } catch (err: unknown) {
      this.logger.error('Exchange rate refresh failed', err instanceof Error ? err.message : String(err));
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

  /** Auto-close professionals past closing hours daily */
  @Cron(CronExpression.EVERY_HOUR)
  async autoManageProfessionalStatus() {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const day = ['sun','mon','tue','wed','thu','fri','sat'][now.getDay()];

    const professionals = await this.prisma.professional.findMany({
      where: { status: 'VALIDATED', openingHours: { not: null } },
    });

    for (const prof of professionals) {
      const hours = prof.openingHours as any;
      if (!hours?.[day]) continue;
      const { open, close } = hours[day];
      const shouldBeOpen = open <= timeStr && timeStr <= close;

      if (prof.isOpen !== shouldBeOpen) {
        await this.prisma.professional.update({
          where: { id: prof.id },
          data: { isOpen: shouldBeOpen },
        });
      }
    }
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
