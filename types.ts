
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
  type: 'reply' | 'url' | 'phone'; 
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
  | 'rich_card'          
  | 'location_request'   
  | 'pickup_location'    // NEW: Specialized Pickup Node
  | 'destination_location' // NEW: Specialized Destination Node
  | 'condition' 
  | 'set_variable'       
  | 'delay'              
  | 'handoff' 
  | 'status_update'
  | 'template';

export interface ConditionRule {
  id: string;
  variable: string;
  operator: 'equals' | 'contains' | 'starts_with' | 'is_set' | 'greater_than' | 'less_than';
  value: string;
}

export interface FlowNodeData {
  id: string;
  label: string;
  type: NodeType;
  
  // Content
  content?: string; 
  mediaUrl?: string;
  headerType?: 'none' | 'image' | 'video' | 'document'; 
  footerText?: string; 
  
  // Interactive Elements
  buttons?: MessageButton[];
  listTitle?: string;
  listButtonText?: string;
  sections?: ListSection[];
  
  // Input & Validation
  variable?: string; 
  validationType?: 'text' | 'email' | 'phone' | 'number' | 'regex' | 'location';
  validationRegex?: string;
  retryMessage?: string; 
  
  // Logic & Operations
  delayTime?: number; 
  operationValue?: string; 
  
  // Branching Logic
  conditions?: ConditionRule[];
  conditionVariable?: string;
  conditionOperator?: string;
  conditionValue?: string;
  
  // Actions
  targetStatus?: LeadStatus;
  
  // Template
  templateName?: string;
  templateLanguage?: string;
  templateVariables?: string[]; 

  [key: string]: any;
}

export interface BotSettings {
  isEnabled: boolean;
  shouldRepeat: boolean;
  routingStrategy: string;
  systemInstruction?: string;
  nodes: any[];
  edges: any[];
  steps?: any[]; 
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
  type: 'text' | 'image' | 'video' | 'document' | 'audio' | 'location' | 'template' | 'interactive' | 'options' | 'video_link' | 'system_error';
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
  currentBotStepId?: string; 
  isHumanMode?: boolean;
}

export interface Driver extends Candidate {
  lastMessage: string;
  lastMessageTime: number;
  source: LeadSource;
  status: LeadStatus;
  isBotActive: boolean;
  notes?: string;
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
