
export enum LeadStatus {
  NEW = 'New',
  QUALIFIED = 'Qualified',
  FLAGGED_FOR_REVIEW = 'Flagged',
  REJECTED = 'Rejected',
  ONBOARDED = 'Onboarded'
}

export enum OnboardingStep {
  WELCOME_SENT = 0,
  DOCUMENTS_RECEIVED = 1,
  VEHICLE_DETAILS = 2,
  AVAILABILITY_SET = 3,
  READY_FOR_REVIEW = 4
}

export type LeadSource = 'Organic' | 'Meta Ad' | 'Referral' | 'Manual';

export interface MessageButton {
  type: 'reply' | 'url' | 'phone' | 'location' | 'copy_code';
  title: string;
  payload?: string; // URL, Phone Number, or ID
}

export interface Message {
  id: string;
  sender: 'driver' | 'system' | 'agent';
  text?: string;
  imageUrl?: string; // Legacy field for basic images
  
  // Rich Card Fields
  headerImageUrl?: string;
  footerText?: string;
  buttons?: MessageButton[];
  templateName?: string; // New: Track template used
  
  timestamp: number;
  type: 'text' | 'image' | 'video_link' | 'template' | 'options' | 'rich_card' | 'audio' | 'document' | 'video';
  options?: string[]; // Legacy for quick replies
  
  // Outbox Status
  status?: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
}

export interface DriverDocument {
  id: string;
  driverId: string;
  docType: 'license' | 'id_proof' | 'rc_book' | 'photo' | 'other';
  fileUrl: string;
  mimeType: string;
  createdAt: number;
  verificationStatus: 'pending' | 'approved' | 'rejected';
  notes?: string;
}

export interface Driver {
  id: string;
  phoneNumber: string;
  name: string;
  source: LeadSource; // Track where the lead came from
  status: LeadStatus;
  lastMessage: string;
  lastMessageTime: number;
  messages: Message[];
  documents: DriverDocument[]; // Updated to use structured documents
  notes?: string;
  
  // New Onboarding Fields
  onboardingStep: OnboardingStep;
  vehicleRegistration?: string;
  availability?: 'Full-time' | 'Part-time' | 'Weekends';
  qualificationChecks: {
    hasValidLicense: boolean;
    hasVehicle: boolean;
    isLocallyAvailable: boolean;
  };
  
  // Bot State Tracking
  currentBotStepId?: string; 
  isBotActive: boolean;
  
  // Human Handover
  isHumanMode?: boolean;
  
  // Internal tracking
  updatedAt?: number;
}

export interface MetaTemplate {
  name: string;
  language: string;
  components: any[];
}

export interface AppNotification {
  id: string;
  type: 'info' | 'warning' | 'success';
  title: string;
  message: string;
}

// --- BOT BUILDER TYPES ---

export type InputType = 'text' | 'image' | 'option' | 'location' | 'card';

export interface BotStep {
  id: string;
  title: string;
  message: string; // Body text
  inputType: InputType; 
  options?: string[]; // Legacy simple options
  saveToField?: 'name' | 'vehicleRegistration' | 'availability' | 'document' | 'email'; 
  nextStepId?: string | 'END' | 'AI_HANDOFF';
  
  // Branching Logic
  routes?: Record<string, string>; 
  
  // Template / Rich Card
  templateName?: string; 
  templateLanguage?: string;
  
  // Rich Media
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'document';
  
  // Rich Card Specifics
  headerImageUrl?: string;
  footerText?: string;
  buttons?: MessageButton[];
  
  // Link Node Specific
  linkLabel?: string;
  
  // New: Scheduling
  delay?: number; // Delay in seconds before sending this step
}

export interface BotSettings {
  isEnabled: boolean;
  shouldRepeat?: boolean; 
  routingStrategy: 'BOT_ONLY' | 'AI_ONLY' | 'HYBRID_BOT_FIRST';
  systemInstruction: string; 
  steps: BotStep[];
  entryPointId?: string; 
  flowData?: {
    nodes: any[];
    edges: any[];
  };
}

// --- SYSTEM MONITOR ---
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

// --- AI AUDIT TYPES ---
export interface AuditIssue {
  nodeId: string;
  severity: 'CRITICAL' | 'WARNING';
  issue: string; 
  suggestion: string; 
  autoFixValue?: any; 
}

export interface AuditReport {
  isValid: boolean;
  issues: AuditIssue[];
  fixedNodes?: any[]; 
}
