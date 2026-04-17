import { IsUUID } from 'class-validator';

export class CreateBlockDto {
  @IsUUID('4')
  userId!: string;
}
