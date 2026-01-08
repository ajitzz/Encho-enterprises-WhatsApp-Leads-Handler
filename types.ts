
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
  DETAILS_COLLECTED = 2,
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

// Enterprise Update: Renamed Driver to Lead to support generic business types (Travelers, Candidates, etc.)
export interface Lead {
  id: string;
  companyId: string; // Enterprise Multi-Tenant Key
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
  
  // Generic Data Fields (Mapped based on Company Terminology)
  customField1?: string; // e.g. Vehicle Registration OR Travel Date
  customField2?: string; // e.g. Availability OR Destination
  
  qualificationChecks: {
    check1: boolean; // e.g. Valid License OR Valid Visa
    check2: boolean; // e.g. Has Vehicle OR Deposit Paid
    check3: boolean; // e.g. Local OR Vaccinated
  };
  
  currentBotStepId?: string; 
  isBotActive: boolean;
  isHumanMode?: boolean;
}

export interface Company {
  id: string;
  name: string;
  type: 'logistics' | 'travel' | 'retail' | 'real_estate';
  terminology: {
    singular: string;    // "Driver" or "Traveler"
    plural: string;      // "Drivers" or "Travelers"
    field1Label: string; // "Vehicle Number" or "Travel Dates"
    field2Label: string; // "Availability" or "Group Size"
    check1Label: string; // "Valid License" or "Valid ID"
    check2Label: string; // "Has Vehicle" or "Deposit Paid"
    check3Label: string; // "Local" or "Visa Cleared"
  };
  themeColor: string;
}

export interface AppNotification {
  id: string;
  type: 'info' | 'warning' | 'success';
  title: string;
  message: string;
}

export type InputType = 'text' | 'image' | 'option' | 'location';

export interface BotStep {
  id: string;
  title: string;
  message: string;
  inputType: InputType;
  options?: string[];
  // Generic save fields
  saveToField?: 'name' | 'customField1' | 'customField2' | 'document' | 'email'; 
  nextStepId?: string | 'END' | 'AI_HANDOFF';
  routes?: Record<string, string>; 
  templateName?: string;
  templateLanguage?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'document';
}

export interface BotSettings {
  companyId: string;
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
