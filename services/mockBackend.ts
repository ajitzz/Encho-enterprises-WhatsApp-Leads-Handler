import { Driver, LeadStatus, Message, OnboardingStep, LeadSource, BotSettings, BotStep } from '../types';

// Initial Bot Config
const DEFAULT_BOT_SETTINGS: BotSettings = {
  isEnabled: true,
  routingStrategy: 'HYBRID_BOT_FIRST',
  systemInstruction: `You are a friendly and persuasive recruiter for Uber Fleet in Kerala.`,
  steps: [
    {
      id: 'step_1',
      title: 'Welcome & Name',
      message: 'നമസ്കാരം! Uber Fleet-ലേക്ക് സ്വാഗതം. നിങ്ങളുടെ പേര് പറയാമോ?',
      inputType: 'text',
      saveToField: 'name',
      nextStepId: 'step_2'
    },
    {
      id: 'step_2',
      title: 'License Check',
      message: 'നന്ദി! നിങ്ങളുടെ കൈയ്യിൽ valid ആയ Commercial Driving License ഉണ്ടോ?',
      inputType: 'option',
      options: ['ഉണ്ട് (Yes)', 'ഇല്ല (No)'],
      nextStepId: 'step_3',
      templateName: 'encho_enterprises', // USING TEMPLATE HERE
      templateLanguage: 'en_US'
    },
    {
      id: 'step_3',
      title: 'Upload License',
      message: 'Verification-ന് വേണ്ടി License-ന്റെ ഒരു ഫോട്ടോ അയച്ചുതരൂ.',
      inputType: 'image',
      saveToField: 'document',
      nextStepId: 'step_4'
    },
    {
      id: 'step_4',
      title: 'Availability',
      message: 'എപ്പോഴാണ് ഡ്രൈവ് ചെയ്യാൻ താല്പര്യം? (Full-time / Part-time)',
      inputType: 'option',
      options: ['Full-time', 'Part-time', 'Weekends'],
      saveToField: 'availability',
      nextStepId: 'AI_HANDOFF' // Hand over to AI for Q&A after basic details
    }
  ]
};

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
    },
    isBotActive: false
  }
];

class MockBackendService {
  private drivers: Driver[] = [...MOCK_DRIVERS];
  private botSettings: BotSettings = { ...DEFAULT_BOT_SETTINGS };
  private listeners: (() => void)[] = [];

  constructor() {
    // Load from local storage
    const savedDrivers = localStorage.getItem('uber_fleet_drivers');
    const savedBot = localStorage.getItem('uber_fleet_bot_settings');
    
    if (savedDrivers) {
      try { this.drivers = JSON.parse(savedDrivers); } catch (e) {}
    }
    if (savedBot) {
      try { this.botSettings = JSON.parse(savedBot); } catch (e) {}
    }
  }

  private persist() {
    localStorage.setItem('uber_fleet_drivers', JSON.stringify(this.drivers));
    localStorage.setItem('uber_fleet_bot_settings', JSON.stringify(this.botSettings));
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

  getBotSettings(): BotSettings {
    return this.botSettings;
  }

  updateBotSettings(settings: BotSettings) {
    this.botSettings = settings;
    this.persist();
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

  updateDriverDetails(driverId: string, updates: Partial<Driver>) {
    const driverIndex = this.drivers.findIndex((d) => d.id === driverId);
    if (driverIndex > -1) {
      this.drivers[driverIndex] = { ...this.drivers[driverIndex], ...updates };
      this.persist();
    }
  }

  updateDriverStatus(driverId: string, status: LeadStatus) {
    const driver = this.drivers.find((d) => d.id === driverId);
    if (driver) {
      driver.status = status;
      this.persist();
    }
  }

  // --- BOT ENGINE ---

  // Called when a user sends a message. Determines if Bot or AI should reply.
  processIncomingMessage(phoneNumber: string, text: string, imageUrl?: string): { driver: Driver, reply?: Message, actionNeeded: 'NONE' | 'AI_REPLY' } {
    let driver = this.drivers.find((d) => d.phoneNumber === phoneNumber);
    let isNew = false;
    const settings = this.botSettings;
    const strategy = settings.routingStrategy || 'HYBRID_BOT_FIRST';

    // 1. Create or Get Driver
    if (!driver) {
      isNew = true;
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
        qualificationChecks: { hasValidLicense: false, hasVehicle: false, isLocallyAvailable: true },
        // Initially active unless AI Only
        isBotActive: settings.isEnabled && strategy !== 'AI_ONLY',
        currentBotStepId: this.botSettings.steps[0]?.id
      };
      this.drivers.push(driver);
    }

    // 2. Add User Message
    const userMsg: Message = {
      id: Date.now().toString(),
      sender: 'driver',
      text: text,
      imageUrl: imageUrl,
      timestamp: Date.now(),
      type: imageUrl ? 'image' : 'text',
    };
    this.addMessage(driver.id, userMsg);

    // 3. Logic Engine

    // STRATEGY: AI ONLY
    if (settings.isEnabled && strategy === 'AI_ONLY') {
      return { driver, actionNeeded: 'AI_REPLY' };
    }

    // STRATEGY: BOT ONLY (Restart Logic)
    if (settings.isEnabled && strategy === 'BOT_ONLY' && !driver.isBotActive && !isNew) {
        // Restart Bot
        const firstStep = settings.steps[0];
        if (firstStep) {
            driver.isBotActive = true;
            driver.currentBotStepId = firstStep.id;
            isNew = true; // Trigger restart immediate reply
        }
    }

    // STRATEGY: BOT FLOW ACTIVE
    if (settings.isEnabled && driver.isBotActive && driver.currentBotStepId) {
      
      const currentStep = settings.steps.find(s => s.id === driver.currentBotStepId);
      
      if (currentStep) {
        // A. PROCESS DATA CAPTURE from previous input
        if (!isNew) { 
             if (currentStep.saveToField === 'name') driver.name = text;
             if (currentStep.saveToField === 'availability') driver.availability = text as any;
             if (currentStep.saveToField === 'document' && imageUrl) driver.documents.push(imageUrl);
             
             // Move to next Step
             let nextId = currentStep.nextStepId;

             if (nextId === 'END' || nextId === 'AI_HANDOFF') {
                 driver.isBotActive = false;
                 driver.currentBotStepId = undefined;
                 this.persist();

                 if (nextId === 'AI_HANDOFF' && strategy === 'HYBRID_BOT_FIRST') {
                     return { driver, actionNeeded: 'AI_REPLY' };
                 } else {
                     // Bot Only End or Hybrid End without Handoff
                     const endMsg: Message = {
                         id: Date.now().toString() + '_end',
                         sender: 'system',
                         text: 'Thank you for your response.',
                         timestamp: Date.now() + 500,
                         type: 'text'
                     };
                     this.addMessage(driver.id, endMsg);
                     return { driver, reply: endMsg, actionNeeded: 'NONE' };
                 }
             } else {
                 driver.currentBotStepId = nextId;
             }
        }

        // B. SEND NEXT MESSAGE
        const nextStep = settings.steps.find(s => s.id === driver.currentBotStepId);
        if (nextStep) {
            const botMsg: Message = {
                id: Date.now().toString() + '_bot',
                sender: 'system',
                text: nextStep.templateName ? `[Template: ${nextStep.templateName}] ${nextStep.message}` : nextStep.message,
                timestamp: Date.now() + 500, // Slight delay
                type: nextStep.templateName ? 'template' : (nextStep.inputType === 'option' ? 'options' : 'text'),
                options: nextStep.options
            };
            this.addMessage(driver.id, botMsg);
            this.persist();
            return { driver, reply: botMsg, actionNeeded: 'NONE' };
        }
      }
    }

    // Fallback to AI if bot is inactive and strategy is HYBRID
    if (settings.isEnabled && strategy === 'HYBRID_BOT_FIRST' && !driver.isBotActive) {
        return { driver, actionNeeded: 'AI_REPLY' };
    }

    // Default for Bot Only if inactive (and didn't restart for some reason)
    return { driver, actionNeeded: 'NONE' };
  }

  // --- AD LEAD ---
  createAdLead(name: string, phoneNumber: string): Driver {
    // ... existing implementation but init bot state ...
    let driver = this.drivers.find((d) => d.phoneNumber === phoneNumber);
    if (driver) return driver;

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
      qualificationChecks: { hasValidLicense: false, hasVehicle: false, isLocallyAvailable: true },
      isBotActive: true,
      currentBotStepId: this.botSettings.steps[0]?.id
    };
    
    this.drivers.push(driver);
    this.persist();
    
    // Trigger first bot message immediately
    const firstStep = this.botSettings.steps[0];
    if (firstStep) {
        setTimeout(() => {
            const isTemplate = !!firstStep.templateName;
            this.addMessage(driver!.id, {
                id: Date.now().toString() + '_auto',
                sender: 'system',
                text: isTemplate ? `[Template: ${firstStep.templateName}] Hi ${name}!` : `Hi ${name}! ${firstStep.message}`,
                type: isTemplate ? 'template' : (firstStep.inputType === 'option' ? 'options' : 'text'),
                options: firstStep.options,
                timestamp: Date.now()
            });
        }, 500);
    }

    return driver;
  }
}

export const mockBackend = new MockBackendService();