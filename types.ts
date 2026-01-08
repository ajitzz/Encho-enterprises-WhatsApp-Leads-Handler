
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
  DETAILS_COLLECTED = 2, // Renamed from VEHICLE_DETAILS
  AVAILABILITY_SET = 3,
  READY_FOR_REVIEW = 4
}

export type LeadSource = 'Organic' | 'Meta Ad' | 'Referral' | 'Manual';

export interface Message {
  id: string;
  sender: 'driver' | 'system' | 'agent';
  text?: string;
  imageUrl?: string;
  timestamp: number;
  type: 'text' | 'image' | 'video_link' | 'template' | 'options';
  options?: string[]; // For buttons
}

// Renamed Driver to Lead to be generic (Driver OR Traveler)
export interface Lead {
  id: string;
  companyId: string; // Multi-tenant key
  phoneNumber: string;
  name: string;
  source: LeadSource;
  status: LeadStatus;
  lastMessage: string;
  lastMessageTime: number;
  messages: Message[];
  documents: string[];
  notes?: string;
  
  onboardingStep: OnboardingStep;
  
  // Generic Data Fields (Mapped based on Company Type)
  customField1?: string; // e.g., Vehicle Registration OR Travel Date
  customField2?: string; // e.g., Availability OR Group Size
  
  qualificationChecks: {
    check1: boolean; // e.g. Valid License OR Valid ID
    check2: boolean; // e.g. Has Vehicle OR Paid Deposit
    check3: boolean; // e.g. Local OR Visa Cleared
  };
  
  currentBotStepId?: string; 
  isBotActive: boolean;
  isHumanMode?: boolean;
}

export interface Company {
  id: string;
  name: string;
  type: 'logistics' | 'travel' | 'retail';
  terminology: {
    singular: string; // "Driver" or "Traveler"
    plural: string;   // "Drivers" or "Travelers"
    field1Label: string; // "Vehicle Number" or "Travel Date"
    field2Label: string; // "Availability" or "Destination"
  };
  themeColor: string; // hex code
}

export interface AppNotification {
  id: string;
  type: 'info' | 'warning' | 'success';
  title: string;
  message: string;
}

// --- BOT BUILDER TYPES ---

export type InputType = 'text' | 'image' | 'option' | 'location';

export interface BotStep {
  id: string;
  title: string;
  message: string;
  inputType: InputType;
  options?: string[];
  // Updated save fields to be generic
  saveToField?: 'name' | 'customField1' | 'customField2' | 'document' | 'email'; 
  nextStepId?: string | 'END' | 'AI_HANDOFF';
  routes?: Record<string, string>; 
  templateName?: string;
  templateLanguage?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'document';
}

export interface BotSettings {
  companyId: string; // Settings per company
  isEnabled: boolean;
  routingStrategy: 'BOT_ONLY' | 'AI_ONLY' | 'HYBRID_BOT_FIRST';
  systemInstruction: string;
  steps: BotStep[];
  entryPointId?: string;
  flowData?: {
    nodes: any[];
    edges: any[];
  };
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
