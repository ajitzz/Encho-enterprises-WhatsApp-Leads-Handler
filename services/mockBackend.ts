import { Driver, LeadStatus, Message, OnboardingStep, LeadSource } from '../types';

// Initial Mock Data
const MOCK_DRIVERS: Driver[] = [
  {
    id: '1',
    phoneNumber: '+91 98765 43210',
    name: 'Rajesh Kumar',
    source: 'Organic',
    status: LeadStatus.NEW,
    lastMessage: 'Hi, I want to join Uber fleet.',
    lastMessageTime: Date.now() - 1000 * 60 * 60 * 2,
    messages: [
      {
        id: 'msg_1',
        sender: 'driver',
        text: 'Hi, I want to join Uber fleet.',
        timestamp: Date.now() - 1000 * 60 * 60 * 2,
        type: 'text',
      },
    ],
    documents: [],
    onboardingStep: OnboardingStep.WELCOME_SENT,
    qualificationChecks: {
      hasValidLicense: false,
      hasVehicle: false,
      isLocallyAvailable: true
    }
  },
  {
    id: '2',
    phoneNumber: '+91 99887 76655',
    name: 'Amit Singh',
    source: 'Meta Ad',
    status: LeadStatus.FLAGGED_FOR_REVIEW,
    lastMessage: '[Image Sent]',
    lastMessageTime: Date.now() - 1000 * 60 * 30,
    messages: [
      {
        id: 'msg_sys_1',
        sender: 'system',
        text: 'Hi Amit, thanks for applying via Facebook! To start, please upload your Driving License.',
        timestamp: Date.now() - 1000 * 60 * 40,
        type: 'template',
      },
      {
        id: 'msg_2',
        sender: 'driver',
        text: 'Is this the correct license?',
        timestamp: Date.now() - 1000 * 60 * 35,
        type: 'text',
      },
      {
        id: 'msg_3',
        sender: 'driver',
        imageUrl: 'https://picsum.photos/400/300', // Placeholder for DL
        timestamp: Date.now() - 1000 * 60 * 30,
        type: 'image',
      },
    ],
    documents: ['https://picsum.photos/400/300'],
    onboardingStep: OnboardingStep.DOCUMENTS_RECEIVED,
    qualificationChecks: {
      hasValidLicense: true, // Mocked as true for this demo user
      hasVehicle: false,
      isLocallyAvailable: true
    }
  },
];

class MockBackendService {
  private drivers: Driver[] = [...MOCK_DRIVERS];
  private listeners: (() => void)[] = [];

  constructor() {
    // Load from local storage if available to persist across reloads
    const saved = localStorage.getItem('uber_fleet_drivers');
    if (saved) {
      try {
        this.drivers = JSON.parse(saved);
      } catch (e) {
        console.error('Failed to parse saved drivers', e);
      }
    }
  }

  private persist() {
    localStorage.setItem('uber_fleet_drivers', JSON.stringify(this.drivers));
    this.notify();
  }

  private notify() {
    this.listeners.forEach((l) => l());
  }

  subscribe(listener: () => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  getDrivers(): Driver[] {
    return this.drivers.sort((a, b) => b.lastMessageTime - a.lastMessageTime);
  }

  getDriver(id: string): Driver | undefined {
    return this.drivers.find((d) => d.id === id);
  }

  addMessage(driverId: string, message: Message) {
    const driverIndex = this.drivers.findIndex((d) => d.id === driverId);
    if (driverIndex > -1) {
      const driver = this.drivers[driverIndex];
      driver.messages.push(message);
      driver.lastMessage = message.type === 'image' ? '[Image Sent]' : (message.text || 'Media');
      driver.lastMessageTime = message.timestamp;
      
      if (message.type === 'image' && message.sender === 'driver') {
         driver.documents.push(message.imageUrl || '');
         driver.onboardingStep = Math.max(driver.onboardingStep, OnboardingStep.DOCUMENTS_RECEIVED);
      }

      this.drivers[driverIndex] = { ...driver };
      this.persist();
    }
  }

  // Update specific driver details (Mocking DB Update)
  updateDriverDetails(driverId: string, updates: Partial<Driver>) {
    const driverIndex = this.drivers.findIndex((d) => d.id === driverId);
    if (driverIndex > -1) {
      this.drivers[driverIndex] = { ...this.drivers[driverIndex], ...updates };
      
      // Auto-update onboarding step based on data presence
      const d = this.drivers[driverIndex];
      if (d.vehicleRegistration && d.onboardingStep < OnboardingStep.VEHICLE_DETAILS) {
        d.onboardingStep = OnboardingStep.VEHICLE_DETAILS;
      }
      if (d.availability && d.onboardingStep < OnboardingStep.AVAILABILITY_SET) {
        d.onboardingStep = OnboardingStep.AVAILABILITY_SET;
      }
      
      this.persist();
    }
  }

  // Simulates a new driver or existing driver sending a message via Webhook
  receiveWebhookMessage(phoneNumber: string, text: string, imageUrl?: string): Driver {
    let driver = this.drivers.find((d) => d.phoneNumber === phoneNumber);
    
    if (!driver) {
      driver = {
        id: Date.now().toString(),
        phoneNumber,
        name: 'Unknown Driver',
        source: 'Organic',
        status: LeadStatus.NEW,
        lastMessage: '',
        lastMessageTime: Date.now(),
        messages: [],
        documents: [],
        onboardingStep: OnboardingStep.WELCOME_SENT,
        qualificationChecks: {
          hasValidLicense: false,
          hasVehicle: false,
          isLocallyAvailable: true
        }
      };
      this.drivers.push(driver);
    }

    const newMessage: Message = {
      id: Date.now().toString() + Math.random().toString(),
      sender: 'driver',
      text: text,
      imageUrl: imageUrl,
      timestamp: Date.now(),
      type: imageUrl ? 'image' : 'text',
    };

    this.addMessage(driver.id, newMessage);
    return driver;
  }

  // Simulates receiving a Lead from Meta Ads (Facebook/Instagram)
  // This happens when a user fills a form. We get the data, but no message from them yet.
  // The SYSTEM initiates the chat.
  createAdLead(name: string, phoneNumber: string): Driver {
    let driver = this.drivers.find((d) => d.phoneNumber === phoneNumber);
    
    if (driver) {
      // Driver exists, just update source to latest
      driver.source = 'Meta Ad';
      this.persist();
      return driver;
    }

    driver = {
      id: Date.now().toString(),
      phoneNumber,
      name,
      source: 'Meta Ad',
      status: LeadStatus.NEW,
      lastMessage: 'Lead Created from Ad',
      lastMessageTime: Date.now(),
      messages: [],
      documents: [],
      onboardingStep: OnboardingStep.WELCOME_SENT,
      qualificationChecks: {
        hasValidLicense: false,
        hasVehicle: false,
        isLocallyAvailable: true
      }
    };
    
    this.drivers.push(driver);
    this.persist();

    // AUTOMATION: Immediate Outreach
    // We simulate the WhatsApp Business API sending a template immediately
    setTimeout(() => {
        this.addMessage(driver!.id, {
            id: Date.now().toString() + '_auto',
            sender: 'system',
            text: `Hi ${name}! Thanks for applying to drive with Uber via Facebook. 🚗\n\nTo get started, do you have a valid Commercial Driving License? (Reply YES/NO)`,
            type: 'template',
            timestamp: Date.now()
        });
    }, 500);

    return driver;
  }

  updateDriverStatus(driverId: string, status: LeadStatus) {
    const driver = this.drivers.find((d) => d.id === driverId);
    if (driver) {
      driver.status = status;
      this.persist();
    }
  }
  
  // Simulated Email Notification
  async sendAdminEmail(subject: string, body: string) {
    console.log(`[MOCK EMAIL SERVER] Sending to admin@uberfleet.com\nSubject: ${subject}\nBody: ${body}`);
    return true;
  }
}

export const mockBackend = new MockBackendService();