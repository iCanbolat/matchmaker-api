export const REPORT_REASONS = [
  'spam',
  'inappropriate',
  'fake',
  'harassment',
  'other',
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_STATUSES = [
  'pending',
  'reviewed',
  'resolved',
  'dismissed',
] as const;

export type ReportStatus = (typeof REPORT_STATUSES)[number];
