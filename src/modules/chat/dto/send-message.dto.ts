import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export const CHAT_MESSAGE_TYPES = ['text', 'image', 'gif', 'audio'] as const;

export type ChatMessageType = (typeof CHAT_MESSAGE_TYPES)[number];

export class SendMessageBodyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  content!: string;

  @IsOptional()
  @IsIn(CHAT_MESSAGE_TYPES)
  messageType?: ChatMessageType;
}

export class SendMessageDto extends SendMessageBodyDto {
  @IsUUID('4')
  conversationId!: string;
}
