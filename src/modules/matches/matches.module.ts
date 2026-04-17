import { Module } from '@nestjs/common';
import { BlocksModule } from '../blocks/blocks.module';
import { MatchesController } from './matches.controller';
import { MatchesService } from './matches.service';

@Module({
  imports: [BlocksModule],
  controllers: [MatchesController],
  providers: [MatchesService],
})
export class MatchesModule {}
