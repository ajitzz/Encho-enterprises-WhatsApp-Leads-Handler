export interface CampaignJob {
  id: string;
  segmentId: string;
  templateId: string;
  status: string;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  metrics: Record<string, number>;
}
