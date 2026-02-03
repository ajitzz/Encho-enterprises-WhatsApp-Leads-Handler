
import { Driver, LeadStatus, Message, OnboardingStep, LeadSource, BotSettings, BotStep } from '../types';

const DEFAULT_BOT_SETTINGS: BotSettings = {
  isEnabled: true,
  shouldRepeat: false,
  routingStrategy: 'BOT_ONLY',
  systemInstruction: "",
  nodes: [
      { id: 'start', type: 'start', position: {x:0,y:0}, data: { type: 'start', label: 'Start', content: 'Welcome to Uber Fleet!' } }
  ],
  edges: []
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

  // --- MOCK STATE MACHINE ENGINE ---
  processIncomingMessage(phoneNumber: string, text: string, imageUrl?: string): { driver: Driver, reply?: Message, actionNeeded: 'NONE' } {
    let driver = this.drivers.find((d) => d.phoneNumber === phoneNumber);
    let settings = this.botSettings;
    const { nodes, edges } = settings;

    // 1. Create/Find Driver
    if (!driver) {
      driver = {
        id: Date.now().toString(),
        phoneNumber,
        name: 'Unknown Driver',
        source: 'Organic',
        status: LeadStatus.NEW,
        stage: LeadStatus.NEW,
        variables: {},
        tags: [],
        lastMessageAt: Date.now(),
        lastMessage: text,
        lastMessageTime: Date.now(),
        messages: [],
        documents: {},
        onboardingStep: OnboardingStep.WELCOME_SENT,
        qualificationChecks: { hasValidLicense: false, hasVehicle: false, isLocallyAvailable: true },
        isBotActive: settings.isEnabled,
        currentBotStepId: undefined,
        isHumanMode: false,
        notes: ''
      };
      this.drivers.push(driver);
    } else {
        driver.lastMessage = text;
        driver.lastMessageTime = Date.now();
    }

    // Log Incoming
    this.addMessage(driver.id, {
        id: Date.now().toString(),
        sender: 'driver',
        text,
        imageUrl,
        timestamp: Date.now(),
        type: imageUrl ? 'image' : 'text'
    });

    if (driver.isHumanMode) return { driver, actionNeeded: 'NONE' };

    // --- ENGINE LOGIC (SIMPLIFIED FOR MOCK) ---
    // This loops until it hits an Input or End
    
    let currentNodeId = driver.currentBotStepId;
    let currentNode = nodes.find(n => n.id === currentNodeId);

    // Initial Start
    if (!currentNode) {
        currentNode = nodes.find(n => n.type === 'start' || n.data?.type === 'start') || nodes[0];
    }

    let nextNodeId = null;

    // IF CONTINUING (Process Input)
    if (currentNodeId) {
        const type = currentNode.data.type;
        // Mock Validation (Assume success for simulator unless 'fail' typed)
        if (type === 'input' && text.toLowerCase() === 'fail') {
             this.addMessage(driver.id, {
                 id: Date.now().toString() + '_err',
                 sender: 'system',
                 text: currentNode.data.retryMessage || "Invalid Input (Simulated)",
                 timestamp: Date.now() + 500,
                 type: 'text'
             });
             return { driver, actionNeeded: 'NONE' };
        }
        
        // Advance
        const edge = edges.find(e => e.source === currentNodeId);
        if (edge) nextNodeId = edge.target;
    } else {
        nextNodeId = currentNode?.id;
    }

    let activeNodeId = nextNodeId;
    let limit = 10;

    while(activeNodeId && limit > 0) {
        limit--;
        const node = nodes.find(n => n.id === activeNodeId);
        if (!node) break;

        const data = node.data || {};
        
        // Execution
        if (data.content && ['text', 'image', 'interactive_button', 'interactive_list', 'start'].includes(data.type)) {
             this.addMessage(driver.id, {
                 id: Date.now().toString() + '_' + limit,
                 sender: 'system',
                 text: data.content,
                 timestamp: Date.now() + (10 - limit) * 100, // Staggered timestamps
                 type: 'text'
             });
        }

        // Wait Check
        if (['input', 'interactive_button', 'interactive_list'].includes(data.type)) {
            driver.currentBotStepId = node.id;
            break; // Stop and wait for user
        }

        // Auto Advance
        const edge = edges.find(e => e.source === node.id);
        if (edge) activeNodeId = edge.target;
        else {
            driver.currentBotStepId = undefined;
            activeNodeId = null;
        }
    }

    this.persist();
    return { driver, actionNeeded: 'NONE' };
  }
  
  createAdLead(name: string, phoneNumber: string): Driver { return this.drivers[0]; } // Stub
}

export const mockBackend = new MockBackendService();
