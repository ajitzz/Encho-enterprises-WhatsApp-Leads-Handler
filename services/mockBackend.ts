
import { Driver, LeadStatus, Message, OnboardingStep, LeadSource, BotSettings, BotStep } from '../types';

const DEFAULT_BOT_SETTINGS: BotSettings = {
  isEnabled: true,
  shouldRepeat: false,
  routingStrategy: 'BOT_ONLY', // Enforced
  systemInstruction: "",
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
      if (!driver.messages) driver.messages = [];
      driver.messages.push(message);
      driver.lastMessage = message.text || '[Media]';
      driver.lastMessageTime = message.timestamp;
      this.persist();
    }
  }

  // --- STRICT BOT ENGINE (SIMULATOR) ---
  processIncomingMessage(phoneNumber: string, text: string, imageUrl?: string): { driver: Driver, reply?: Message, actionNeeded: 'NONE' } {
    let driver = this.drivers.find((d) => d.phoneNumber === phoneNumber);
    let settings = this.botSettings;
    const entryPointId = settings.entryPointId || settings.steps?.[0]?.id;

    // 1. New Driver Creation
    if (!driver) {
      const shouldActivateBot = settings.isEnabled;
      driver = {
        id: Date.now().toString(),
        phoneNumber,
        name: 'Unknown Driver',
        source: 'Organic',
        status: LeadStatus.NEW,
        lastMessage: text,
        lastMessageTime: Date.now(),
        messages: [],
        documents: {}, // Fixed: initialized as empty object instead of array
        onboardingStep: OnboardingStep.WELCOME_SENT,
        qualificationChecks: { hasValidLicense: false, hasVehicle: false, isLocallyAvailable: true },
        isBotActive: shouldActivateBot,
        currentBotStepId: undefined, // Start with UNDEFINED to trigger wake-up
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

    // 2. Bot Logic (NO AI)
    let replyMsg: Message | undefined;

    // Fix: Allow processing if Bot Enabled AND (Driver Active OR Repeat is ON)
    const shouldProcess = settings.isEnabled && (driver.isBotActive || settings.shouldRepeat);

    if (shouldProcess) {
        let currentStep = settings.steps.find(s => s.id === driver.currentBotStepId);
        
        // CASE 1: RESTART / WAKE UP / INITIALIZE
        if (!currentStep && settings.steps.length > 0) {
            const entryStep = settings.steps.find(s => s.id === entryPointId) || settings.steps[0];
            if (entryStep) {
                 driver.currentBotStepId = entryStep.id;
                 driver.isBotActive = true; // Reactivate
                 
                 // Determine correct message type for simulator
                 let msgType: any = entryStep.options ? 'options' : 'text';
                 if (entryStep.mediaUrl) {
                    if (entryStep.mediaType === 'video') msgType = 'video_link'; // Use video_link type for videos
                    else msgType = 'image';
                 }

                 replyMsg = {
                    id: Date.now().toString() + '_bot',
                    sender: 'system',
                    text: entryStep.message,
                    timestamp: Date.now() + 500,
                    type: msgType,
                    options: entryStep.options,
                    imageUrl: entryStep.mediaUrl
                };
                if (entryStep.linkLabel && entryStep.message) {
                    replyMsg.text = `${entryStep.linkLabel}\n${entryStep.message}`;
                }
                this.addMessage(driver.id, replyMsg);
                this.persist();
                return { driver, reply: replyMsg, actionNeeded: 'NONE' };
            }
        }
        
        // CASE 2: NORMAL FLOW
        else if (currentStep) {
            let nextId = currentStep.nextStepId;

            if (currentStep.routes && Object.keys(currentStep.routes).length > 0) {
                const input = text.toLowerCase();
                const matched = Object.keys(currentStep.routes).find(k => input.includes(k.toLowerCase()));
                if (matched) {
                    nextId = currentStep.routes[matched];
                } else {
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
            
            if (currentStep.saveToField && currentStep.saveToField === 'name') driver.name = text;

            if (nextId && nextId !== 'END' && nextId !== 'AI_HANDOFF') {
                driver.currentBotStepId = nextId;
                const nextStep = settings.steps.find(s => s.id === nextId);
                if (nextStep) {
                     // Determine correct message type for simulator
                     let msgType: any = nextStep.options ? 'options' : 'text';
                     if (nextStep.mediaUrl) {
                        if (nextStep.mediaType === 'video') msgType = 'video_link'; // Use video_link type for videos
                        else msgType = 'image';
                     }

                     replyMsg = {
                        id: Date.now().toString() + '_bot',
                        sender: 'system',
                        text: nextStep.message,
                        timestamp: Date.now() + 500,
                        type: msgType,
                        options: nextStep.options,
                        imageUrl: nextStep.mediaUrl
                    };
                    if (nextStep.linkLabel && nextStep.message) {
                        replyMsg.text = `${nextStep.linkLabel}\n${nextStep.message}`;
                    }
                    this.addMessage(driver.id, replyMsg);
                }
            } else if (nextId === 'END' || nextId === 'AI_HANDOFF') {
                // End of Flow - Logic Update for Repeat
                if (settings.shouldRepeat) {
                    // Loop enabled: Keep active, reset step to null
                    driver.isBotActive = true;
                    driver.currentBotStepId = undefined;
                } else {
                    // Default: Deactivate
                    driver.isBotActive = false;
                    driver.currentBotStepId = undefined;
                }
                
                replyMsg = {
                    id: Date.now().toString() + '_end',
                    sender: 'system',
                    text: "Thank you! We have received your details. Our team will verify them and contact you shortly.",
                    timestamp: Date.now() + 500,
                    type: 'text'
                };
                this.addMessage(driver.id, replyMsg);
            }
        }
    } 

    this.persist();
    return { driver, reply: replyMsg, actionNeeded: 'NONE' };
  }
  
  createAdLead(name: string, phoneNumber: string): Driver { return this.drivers[0]; } // Stub
}

export const mockBackend = new MockBackendService();
