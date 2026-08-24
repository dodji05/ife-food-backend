import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { UploadsModule } from '../uploads/uploads.module';
import { TasksModule } from '../tasks/tasks.module';
import { DriversModule } from '../drivers/drivers.module';

@Module({
  imports: [NotificationsModule, UploadsModule, TasksModule, DriversModule],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
