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

export interface Message {
  id: string;
  sender: 'driver' | 'system' | 'agent';
  text?: string;
  imageUrl?: string;
  timestamp: number;
  type: 'text' | 'image' | 'video_link' | 'template' | 'options';
  options?: string[]; // For buttons
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
  documents: string[]; // URLs to documents
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
}

export interface MetaTemplate {
  name: string;
  language: string;
  components: any[];
}

export interface Notification {
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
  message: string; // What the bot says (Fallback text if template used)
  inputType: InputType; // What the user should reply with
  options?: string[]; // If inputType is 'option'
  saveToField?: 'name' | 'vehicleRegistration' | 'availability' | 'document'; // Where to save the data
  nextStepId?: string | 'END' | 'AI_HANDOFF';
  
  // Template Integration
  templateName?: string; // The ID/Name of the template in Meta
  templateLanguage?: string; // e.g. en_US, ml_IN
}

export interface BotSettings {
  isEnabled: boolean;
  routingStrategy: 'BOT_ONLY' | 'AI_ONLY' | 'HYBRID_BOT_FIRST';
  systemInstruction: string; // The "Training" for Gemini
  steps: BotStep[];
}