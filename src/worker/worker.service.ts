import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

// ponytail: skeleton only. The pgmq poll loop, dispatch and graceful drain (§9.1) arrive in slice 3.
@Injectable()
export class WorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(WorkerService.name);

  onApplicationBootstrap(): void {
    this.log.log('worker started (no poll loop yet — slice 3)');
  }

  onApplicationShutdown(signal?: string): void {
    this.log.log(`worker stopping (${signal ?? 'no signal'})`);
  }
}
