
export enum LeadStatus {
  NEW = 'New',
  QUALIFIED = 'Qualified',
  FLAGGED_FOR_REVIEW = 'Flagged',
  REJECTED = 'Rejected',
  ONBOARDED = 'Onboarded',
  INTERVIEW_SCHEDULED = 'Interview Scheduled'
}

export enum OnboardingStep {
  WELCOME_SENT = 'WELCOME_SENT',
  DETAILS_REQUESTED = 'DETAILS_REQUESTED',
  DETAILS_RECEIVED = 'DETAILS_RECEIVED'
}

export type LeadSource = 'Organic' | 'Meta Ad' | 'Referral' | 'Manual';

export interface MessageButton {
  id: string;
  title: string;
  type: 'reply' | 'url' | 'phone'; // WhatsApp standard
  payload?: string;
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

export interface ListSection {
  title: string;
  rows: ListRow[];
}

export type NodeType = 
  | 'start' 
  | 'text' 
  | 'image' 
  | 'video' 
  | 'audio' 
  | 'document' 
  | 'input' 
  | 'interactive_button' 
  | 'interactive_list' 
  | 'condition' 
  | 'handoff' 
  | 'status_update';

export interface ConditionRule {
  id: string;
  variable: string;
  operator: 'equals' | 'contains' | 'starts_with' | 'is_set';
  value: string;
}

export interface FlowNodeData {
  id: string;
  label: string;
  type: NodeType;
  
  // Content
  content?: string; // Text body
  mediaUrl?: string;
  footerText?: string; // WhatsApp footer
  
  // Interactive
  buttons?: MessageButton[];
  listTitle?: string;
  listButtonText?: string;
  sections?: ListSection[];
  
  // Logic / Input
  variable?: string; // Save input to this variable
  validationType?: 'text' | 'email' | 'phone' | 'number' | 'none';
  
  // Branching
  conditions?: ConditionRule[];
  
  // Actions
  targetStatus?: LeadStatus;
  
  [key: string]: any;
}

export interface BotStep {
  id: string;
  title?: string;
  message: string;
  inputType?: string;
  saveToField?: string;
  nextStepId?: string;
  options?: string[];
  routes?: Record<string, string>;
  mediaUrl?: string;
  mediaType?: string;
  linkLabel?: string;
}

export interface BotSettings {
  isEnabled: boolean;
  shouldRepeat: boolean;
  routingStrategy: string;
  systemInstruction?: string;
  nodes: any[];
  edges: any[];
  // Legacy / Simulator fields
  steps?: BotStep[];
  entryPointId?: string;
}

export interface BotVersion {
  id: string;
  status: 'draft' | 'published';
  settings: BotSettings;
  created_at: string;
}

export interface Message {
  id: string;
  sender: 'system' | 'agent' | 'driver' | 'bot';
  text?: string;
  imageUrl?: string;
  videoUrl?: string;
  documentUrl?: string;
  timestamp: number;
  type: 'text' | 'image' | 'video' | 'document' | 'audio' | 'location' | 'template' | 'interactive' | 'options' | 'video_link';
  status?: 'sent' | 'delivered' | 'read' | 'failed' | 'processing' | 'sending';
  options?: string[];
  templateName?: string;
  payload?: any;
}

export interface Candidate {
  id: string;
  phoneNumber: string;
  name: string;
  stage: LeadStatus;
  variables: Record<string, any>;
  documents: Record<string, { url: string; type: string; timestamp: number }>;
  tags: string[];
  lastMessageAt: number;
  assignedAgent?: string;
  messages?: Message[];
  currentBotStepId?: string; // Tracks where they are in the graph
  isHumanMode?: boolean;
}

export interface Driver extends Candidate {
  lastMessage: string;
  lastMessageTime: number;
  source: LeadSource;
  status: LeadStatus;
  isBotActive: boolean;
  notes?: string;
  // Simulator specific fields
  onboardingStep?: OnboardingStep;
  qualificationChecks?: {
    hasValidLicense: boolean;
    hasVehicle: boolean;
    isLocallyAvailable: boolean;
  };
}

export interface SystemStats {
    serverLoad: number; 
    dbLatency: number; 
    aiCredits: number; 
    aiModel: string; 
    s3Status: 'ok' | 'error';
    s3Load: number; 
    whatsappStatus: 'ok' | 'latency' | 'error';
    whatsappUploadLoad: number; 
    activeUploads: number;
    uptime: number;
}

export interface AppNotification {
  id: string;
  type: 'info' | 'warning' | 'success';
  title: string;
  message: string;
}

export interface DriverDocument {
  id: string;
  docType: string;
  url: string;
  verificationStatus: 'pending' | 'approved' | 'rejected';
  timestamp: number;
}

export interface ScheduledMessage {
  id: string;
  scheduledTime: number;
  payload: {
    text?: string;
    mediaUrl?: string;
    mediaType?: string;
  };
  status: 'pending' | 'processing' | 'failed' | 'sent';
}

export interface AuditIssue {
  nodeId: string;
  severity: 'CRITICAL' | 'WARNING';
  issue: string;
  suggestion: string;
  autoFixValue?: string;
}

export interface AuditReport {
  isValid: boolean;
  issues: AuditIssue[];
}
