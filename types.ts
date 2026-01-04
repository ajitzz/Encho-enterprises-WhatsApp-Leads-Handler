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
  type: 'text' | 'image' | 'video_link' | 'template';
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