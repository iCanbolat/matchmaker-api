export const NOTIFICATION_TYPES = [
  'match',
  'message',
  'like',
  'super_like',
  'profile_view',
  'system',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const DEVICE_PLATFORMS = ['ios', 'android', 'web'] as const;

export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export type PushDeliveryJobPayload = {
  notificationId: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string | null;
  data: Record<string, unknown> | null;
};
