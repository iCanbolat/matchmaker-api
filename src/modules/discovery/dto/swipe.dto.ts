import { IsIn, IsUUID } from 'class-validator';

export const SWIPE_DIRECTIONS = ['like', 'dislike', 'super_like'] as const;

export type SwipeDirection = (typeof SWIPE_DIRECTIONS)[number];

export class SwipeDto {
  @IsUUID('4')
  swipedUserId!: string;

  @IsIn(SWIPE_DIRECTIONS)
  direction!: SwipeDirection;
}
