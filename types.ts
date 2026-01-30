
export enum LeadStatus {
  NEW = 'New',
  QUALIFIED = 'Qualified',
  FLAGGED_FOR_REVIEW = 'Flagged',
  REJECTED = 'Rejected',
  ONBOARDED = 'Onboarded',
  INTERVIEW_SCHEDULED = 'Interview Scheduled'
}

export type LeadSource = 'Organic' | 'Meta Ad' | 'Referral' | 'Manual';

export interface MessageButton {
  type: 'reply' | 'url' | 'phone' | 'copy_code' | 'location';
  title: string;
  payload?: string;
  id?: string; // Unique ID for routing
}

// --- NEW FLOW TYPES ---

export type NodeType = 
  | 'message' 
  | 'question' 
  | 'buttons' 
  | 'list' 
  | 'condition' 
  | 'document' 
  | 'status' 
  | 'handoff' 
  | 'start' 
  | 'end';

export interface ValidationRule {
  type: 'text' | 'number' | 'email' | 'phone' | 'regex';
  regex?: string;
  min?: number;
  max?: number;
  errorMessage?: string;
}

export interface ConditionRule {
  variable: string;
  operator: 'equals' | 'contains' | 'greater_than' | 'less_than' | 'exists';
  value?: string | number;
  nextStepId: string;
}

export interface FlowNodeData {
  id: string;
  label: string; // Display name
  type: NodeType;
  content?: string; // Text message
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'document';
  
  // Question / Input
  variable?: string; // Name of variable to store result in
  validation?: ValidationRule;
  
  // Interactive
  buttons?: MessageButton[];
  listSections?: { title: string; rows: { id: string; title: string; description?: string }[] }[];
  
  // Logic
  conditions?: ConditionRule[];
  defaultNextStepId?: string;
  
  // Actions
  targetStatus?: LeadStatus; // For Status Node
  
  // Metadata
  isTerminal?: boolean; // Ends flow
  warning?: string; // UI Validation warning
  [key: string]: any;
}

export interface BotVersion {
  id: string;
  phoneNumberId: string;
  versionNumber: number;
  status: 'draft' | 'published';
  nodes: any[]; // React Flow Nodes
  edges: any[]; // React Flow Edges
  createdAt: string;
}

// --- CANDIDATE TYPES ---

export interface Message {
  id: string;
  sender: 'system' | 'agent' | 'driver' | 'bot';
  text?: string;
  imageUrl?: string;
  videoUrl?: string;
  documentUrl?: string;
  timestamp: number;
  type: 'text' | 'image' | 'video' | 'document' | 'audio' | 'location' | 'template' | 'interactive' | 'options' | 'video_link';
  status?: 'sent' | 'delivered' | 'read' | 'failed' | 'processing';
  options?: string[];
  templateName?: string;
  payload?: any;
  headerImageUrl?: string;
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
  messages?: Message[]; // For UI view
}

export enum OnboardingStep {
  WELCOME_SENT = 'WELCOME_SENT',
  // Add others if needed
}

export interface BotStep {
  id: string;
  title?: string;
  message: string;
  inputType?: 'text' | 'option' | 'image' | 'video' | 'document';
  options?: string[];
  saveToField?: string;
  nextStepId?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'document';
  linkLabel?: string;
  routes?: Record<string, string>;
}

export interface BotSettings {
  isEnabled: boolean;
  shouldRepeat: boolean;
  routingStrategy: 'BOT_ONLY' | 'HYBRID' | 'HUMAN_FIRST' | string;
  systemInstruction?: string;
  steps: BotStep[];
  entryPointId?: string;
  nodes?: any[];
  edges?: any[];
}

// Legacy types support
export interface Driver extends Candidate {
  lastMessage: string;
  lastMessageTime: number;
  source: LeadSource;
  status: LeadStatus;
  isBotActive: boolean;
  isHumanMode?: boolean;
  humanModeEndsAt?: number;
  // Added missing properties
  notes?: string;
  currentBotStepId?: string;
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
    templateName?: string;
  };
  status: 'pending' | 'processing' | 'failed' | 'sent';
}
