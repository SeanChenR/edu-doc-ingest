import { Module } from '@nestjs/common';

import { HealthModule } from '@/api/modules/health/health.module';
import { ConfigModule } from '@/shared/config/config.module';
import { DbModule } from '@/shared/db/db.module';

@Module({
  imports: [ConfigModule, DbModule.register('DATABASE_URL'), HealthModule],
})
export class ApiModule {}
