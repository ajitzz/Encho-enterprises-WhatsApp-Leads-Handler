export interface ConversationState {
  leadId: string;
  currentStepId: string;
  variables: Record<string, unknown>;
  lastInboundType?: string;
  lastInboundAt?: number;
  version: number;
}
