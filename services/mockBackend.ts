import { Driver, LeadStatus, Message, OnboardingStep, LeadSource, BotSettings, BotStep } from '../types';

// Initial Bot Config (Reduced to default fallback, as we now prefer flowData)
const DEFAULT_BOT_SETTINGS: BotSettings = {
  isEnabled: true,
  routingStrategy: 'HYBRID_BOT_FIRST',
  systemInstruction: 'You are a friendly recruiter.',
  steps: [],
  flowData: {
      nodes: [
          { id: 'start', type: 'custom', data: { type: 'start' }, position: { x: 50, y: 100 } },
          { id: 'node_1', type: 'custom', data: { label: 'Text', message: 'Hello! Replace this sample message!', inputType: 'text' }, position: { x: 250, y: 100 } }
      ],
      edges: [
          { id: 'e1', source: 'start', target: 'node_1' }
      ]
  }
};

const MOCK_DRIVERS: Driver[] = [
  {
    id: '1',
    phoneNumber: '+91 98765 43210',
    name: 'Rajesh Kumar',
    source: 'Organic',
    status: LeadStatus.NEW,
    lastMessage: 'Hi',
    lastMessageTime: Date.now() - 1000 * 60 * 60 * 2,
    messages: [],
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
    const savedDrivers = localStorage.getItem('uber_fleet_drivers');
    const savedBot = localStorage.getItem('uber_fleet_bot_settings');
    if (savedDrivers) { try { this.drivers = JSON.parse(savedDrivers); } catch (e) {} }
    if (savedBot) { try { this.botSettings = JSON.parse(savedBot); } catch (e) {} }
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

  addMessage(driverId: string, message: Message) {
    const driverIndex = this.drivers.findIndex((d) => d.id === driverId);
    if (driverIndex > -1) {
      const driver = this.drivers[driverIndex];
      driver.messages.push(message);
      driver.lastMessage = message.text || (message.type === 'image' ? '[Image]' : 'Media');
      driver.lastMessageTime = message.timestamp;
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

  createAdLead(name: string, phoneNumber: string): Driver {
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
        currentBotStepId: undefined
    };

    // Auto-start bot for ad leads
    if(this.botSettings.isEnabled && this.botSettings.routingStrategy !== 'AI_ONLY') {
         this.processBotStep(driver, 'trigger_start');
    }

    this.drivers.push(driver);
    this.persist();
    return driver;
  }

  // --- BOT ENGINE (MOCK) ---
  
  processIncomingMessage(phoneNumber: string, text: string, imageUrl?: string): { driver: Driver, actionNeeded: 'NONE' | 'AI_REPLY' } {
    let driver = this.drivers.find((d) => d.phoneNumber === phoneNumber);
    if (!driver) {
      // New Driver Logic
      driver = this.createAdLead('Unknown Driver', phoneNumber); // Re-use logic
      driver.source = 'Organic';
    }

    this.addMessage(driver.id, {
        id: Date.now().toString(),
        sender: 'driver',
        text,
        imageUrl,
        timestamp: Date.now(),
        type: imageUrl ? 'image' : 'text'
    });

    if (text.toLowerCase() === 'reset') {
        driver.isBotActive = true;
        driver.currentBotStepId = undefined;
        this.addMessage(driver.id, { id: 'sys', sender: 'system', text: 'Bot Reset.', timestamp: Date.now(), type: 'text' });
        this.persist();
        return { driver, actionNeeded: 'NONE' };
    }

    const settings = this.botSettings;
    if (settings.isEnabled && settings.routingStrategy === 'AI_ONLY') {
        return { driver, actionNeeded: 'AI_REPLY' };
    }

    if (settings.isEnabled && settings.routingStrategy === 'HYBRID_BOT_FIRST') {
        const handled = this.processBotStep(driver, text);
        if (handled) return { driver, actionNeeded: 'NONE' };
        
        // If bot didn't handle (end of flow), return AI
        return { driver, actionNeeded: 'AI_REPLY' };
    }

    return { driver, actionNeeded: 'AI_REPLY' };
  }

  private processBotStep(driver: Driver, input: string): boolean {
      const { nodes, edges } = this.botSettings.flowData || { nodes: [], edges: [] };
      if (!nodes.length) return false;

      let currentNodeId = driver.currentBotStepId;
      let currentNode = nodes.find(n => n.id === currentNodeId);

      // 1. Process Input for *Current* Node
      if (currentNode) {
           // Find Next
           let nextEdge;
           if (currentNode.data.options && currentNode.data.options.length > 0) {
               const idx = currentNode.data.options.findIndex((o: string) => o.toLowerCase().includes(input.toLowerCase()));
               if (idx !== -1) {
                   nextEdge = edges.find(e => e.source === currentNodeId && e.sourceHandle === `opt_${idx}`);
               }
           }
           if (!nextEdge) {
               nextEdge = edges.find(e => e.source === currentNodeId && (e.sourceHandle === 'main' || !e.sourceHandle));
           }

           if (nextEdge) {
               currentNodeId = nextEdge.target;
               currentNode = nodes.find(n => n.id === currentNodeId);
           } else {
               driver.isBotActive = false; // End of flow
               this.persist();
               return false; 
           }
      } else {
           // Start Flow
           const startNode = nodes.find(n => n.data.type === 'start');
           if (startNode) {
               const e = edges.find(e => e.source === startNode.id);
               if (e) {
                   currentNodeId = e.target;
                   currentNode = nodes.find(n => n.id === currentNodeId);
               }
           }
      }

      // 2. Output Chain
      if (currentNode) {
          driver.currentBotStepId = currentNode.id;
          
          this.addMessage(driver.id, {
              id: Date.now().toString() + '_bot',
              sender: 'system',
              text: currentNode.data.message || '',
              timestamp: Date.now() + 500,
              type: currentNode.data.options ? 'options' : 'text',
              options: currentNode.data.options,
              imageUrl: currentNode.data.mediaUrl
          });

          // Check if auto-advance needed (statements)
          // "Text" (Message) node uses inputType: 'statement' in BotBuilder constants
          // "Text" (Input) node uses inputType: 'text'
          const isInput = ['text', 'number', 'email', 'option'].includes(currentNode.data.inputType) || (currentNode.data.options && currentNode.data.options.length > 0);
          
          if (!isInput) {
              // Recursive step for statements
              setTimeout(() => this.processBotStep(driver, 'continue'), 1000);
          }
          
          this.persist();
          return true;
      }

      return false;
  }
}

export const mockBackend = new MockBackendService();