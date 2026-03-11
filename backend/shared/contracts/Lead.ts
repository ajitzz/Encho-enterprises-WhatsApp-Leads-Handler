export interface Lead {
  id: string;
  phoneNumber: string;
  name: string;
  stage: string;
  ownerId?: string;
  status: string;
  lastMessage?: string;
  lastMessageAt?: number;
  variables: Record<string, unknown>;
  isHumanMode: boolean;
}
