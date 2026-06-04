import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TasksService } from './tasks.service';

@Module({
  imports: [ScheduleModule],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
