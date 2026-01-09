
import { Driver, LeadStatus, Message, OnboardingStep, LeadSource, BotSettings, BotStep } from '../types';

const DEFAULT_BOT_SETTINGS: BotSettings = {
  isEnabled: true,
  routingStrategy: 'HYBRID_BOT_FIRST',
  systemInstruction: "You are a helpful assistant.",
  steps: [
    {
      id: 'step_1',
      title: 'Welcome',
      message: 'Welcome to Encho Cabs! What is your name?',
      inputType: 'text',
      saveToField: 'name',
      nextStepId: 'step_2'
    },
    {
      id: 'step_2',
      title: 'Role',
      message: 'Are you looking to Rent or Drive?',
      inputType: 'option',
      options: ['Rent', 'Drive Own Car'],
      nextStepId: 'AI_HANDOFF'
    }
  ],
  entryPointId: 'step_1'
};

const MOCK_DRIVERS: Driver[] = [];

class MockBackendService {
  private drivers: Driver[] = [];
  private botSettings: BotSettings = { ...DEFAULT_BOT_SETTINGS };
  private listeners: (() => void)[] = [];

  constructor() {
    const savedDrivers = localStorage.getItem('uber_fleet_drivers');
    const savedBot = localStorage.getItem('uber_fleet_bot_settings');
    
    if (savedDrivers) { try { this.drivers = JSON.parse(savedDrivers); } catch (e) {} }
    else { this.drivers = MOCK_DRIVERS; }
    
    if (savedBot) { try { this.botSettings = JSON.parse(savedBot); } catch (e) {} }
  }

  private persist() {
    localStorage.setItem('uber_fleet_drivers', JSON.stringify(this.drivers));
    localStorage.setItem('uber_fleet_bot_settings', JSON.stringify(this.botSettings));
    this.notify();
  }

  private notify() { this.listeners.forEach((l) => l()); }

  subscribe(listener: () => void) {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
  }

  getDrivers(): Driver[] { return this.drivers.sort((a, b) => b.lastMessageTime - a.lastMessageTime); }
  getBotSettings(): BotSettings { return this.botSettings; }
  updateBotSettings(settings: BotSettings) { this.botSettings = settings; this.persist(); }
  getDriver(id: string): Driver | undefined { return this.drivers.find((d) => d.id === id); }
  
  updateDriverDetails(driverId: string, updates: Partial<Driver>) {
    const driverIndex = this.drivers.findIndex((d) => d.id === driverId);
    if (driverIndex > -1) {
      this.drivers[driverIndex] = { ...this.drivers[driverIndex], ...updates };
      this.persist();
    }
  }

  updateDriverStatus(driverId: string, status: LeadStatus) {
    this.updateDriverDetails(driverId, { status });
  }

  addMessage(driverId: string, message: Message) {
    const driver = this.drivers.find((d) => d.id === driverId);
    if (driver) {
      driver.messages.push(message);
      driver.lastMessage = message.text || '[Media]';
      driver.lastMessageTime = message.timestamp;
      this.persist();
    }
  }

  // --- STRICT BOT ENGINE (SIMULATOR) ---
  processIncomingMessage(phoneNumber: string, text: string, imageUrl?: string): { driver: Driver, reply?: Message, actionNeeded: 'NONE' | 'AI_REPLY' } {
    let driver = this.drivers.find((d) => d.phoneNumber === phoneNumber);
    let settings = this.botSettings;
    const entryPointId = settings.entryPointId || settings.steps?.[0]?.id;

    // 1. New Driver Creation
    if (!driver) {
      const shouldActivateBot = settings.isEnabled && settings.routingStrategy !== 'AI_ONLY';
      driver = {
        id: Date.now().toString(),
        phoneNumber,
        name: 'Unknown Driver',
        source: 'Organic',
        status: LeadStatus.NEW,
        lastMessage: text,
        lastMessageTime: Date.now(),
        messages: [],
        documents: [],
        onboardingStep: OnboardingStep.WELCOME_SENT,
        qualificationChecks: { hasValidLicense: false, hasVehicle: false, isLocallyAvailable: true },
        isBotActive: shouldActivateBot,
        currentBotStepId: entryPointId,
        isHumanMode: false,
        notes: ''
      };
      this.drivers.push(driver);
    } else {
        driver.lastMessage = text;
        driver.lastMessageTime = Date.now();
    }

    // Add User Message
    this.addMessage(driver.id, {
        id: Date.now().toString(),
        sender: 'driver',
        text,
        imageUrl,
        timestamp: Date.now(),
        type: imageUrl ? 'image' : 'text'
    });

    if (driver.isHumanMode) return { driver, actionNeeded: 'NONE' };

    // 2. Bot Logic
    let replyMsg: Message | undefined;
    let actionNeeded: 'NONE' | 'AI_REPLY' = 'NONE';

    // Strict Check: If bot active, ONLY do bot stuff
    if (settings.isEnabled && driver.isBotActive) {
        let currentStep = settings.steps.find(s => s.id === driver.currentBotStepId);
        
        // Recover step
        if (!currentStep && settings.steps.length > 0) {
            driver.currentBotStepId = entryPointId;
            currentStep = settings.steps.find(s => s.id === entryPointId);
        }

        if (currentStep) {
            let nextId = currentStep.nextStepId;

            // Route Check
            if (currentStep.routes && Object.keys(currentStep.routes).length > 0) {
                const input = text.toLowerCase();
                const matched = Object.keys(currentStep.routes).find(k => input.includes(k.toLowerCase()));
                if (matched) {
                    nextId = currentStep.routes[matched];
                } else {
                    // Invalid input, stay on step, ask again
                    replyMsg = {
                        id: Date.now().toString() + '_bot',
                        sender: 'system',
                        text: "Please select one of the valid options:",
                        timestamp: Date.now() + 500,
                        type: 'options',
                        options: currentStep.options
                    };
                    this.addMessage(driver.id, replyMsg);
                    return { driver, reply: replyMsg, actionNeeded: 'NONE' };
                }
            }
            
            // Save Data
            if (currentStep.saveToField) {
                 if (currentStep.saveToField === 'name') driver.name = text;
                 // ... other fields
            }

            // Transition
            if (nextId && nextId !== 'END' && nextId !== 'AI_HANDOFF') {
                driver.currentBotStepId = nextId;
                const nextStep = settings.steps.find(s => s.id === nextId);
                if (nextStep) {
                     replyMsg = {
                        id: Date.now().toString() + '_bot',
                        sender: 'system',
                        text: nextStep.message,
                        timestamp: Date.now() + 500,
                        type: nextStep.options ? 'options' : 'text',
                        options: nextStep.options,
                        imageUrl: nextStep.mediaUrl
                    };
                    if (nextStep.linkLabel && nextStep.message) {
                        replyMsg.text = `${nextStep.linkLabel}\n${nextStep.message}`;
                    }
                    this.addMessage(driver.id, replyMsg);
                }
            } else {
                // End of Flow
                driver.isBotActive = false;
                driver.currentBotStepId = undefined;
                
                if (nextId === 'AI_HANDOFF' && settings.routingStrategy === 'HYBRID_BOT_FIRST') {
                    actionNeeded = 'AI_REPLY';
                } else if (settings.routingStrategy === 'BOT_ONLY') {
                    // Do nothing or send generic close
                    replyMsg = {
                        id: Date.now().toString() + '_end',
                        sender: 'system',
                        text: "Thank you.",
                        timestamp: Date.now() + 500,
                        type: 'text'
                    };
                    this.addMessage(driver.id, replyMsg);
                }
            }
        }
    } 
    // If bot not active, check strategy
    else if (!driver.isBotActive && settings.isEnabled) {
        if (settings.routingStrategy !== 'BOT_ONLY') {
            actionNeeded = 'AI_REPLY';
        }
    }

    this.persist();
    return { driver, reply: replyMsg, actionNeeded };
  }
  
  // (Other methods kept minimal for brevity, assume unchanged)
  createAdLead(name: string, phoneNumber: string): Driver { return this.drivers[0]; } // Stub
}

export const mockBackend = new MockBackendService();
