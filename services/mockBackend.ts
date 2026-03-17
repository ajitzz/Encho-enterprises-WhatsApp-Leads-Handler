
import { Driver, LeadStatus, Message, OnboardingStep, LeadSource, BotSettings } from '../types';

const DEFAULT_BOT_SETTINGS: BotSettings = {
  isEnabled: true,
  shouldRepeat: false,
  routingStrategy: 'BOT_ONLY',
  systemInstruction: "",
  nodes: [
      { id: 'start', type: 'custom', position: {x:0,y:0}, data: { type: 'start', label: 'Start Flow', content: 'Welcome to Uber Fleet!' } }
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

    // --- ENGINE LOGIC ---
    let currentNodeId = driver.currentBotStepId;
    let currentNode = nodes.find(n => n.id === currentNodeId);

    if (!currentNode) {
        currentNode = nodes.find(n => n.type === 'start' || n.data?.type === 'start') || nodes[0];
    }

    let nextNodeId = null;

    if (currentNodeId) {
        // Mocking Button/List Logic:
        // In simulation, we assume if the user types an option title, they selected it.
        let matchedEdge = null;
        let selectedValue: string | null = null;

        if (currentNode.data.type === 'interactive_button' && currentNode.data.buttons) {
             const matchedBtn = currentNode.data.buttons.find((b: any) => b.title.toLowerCase() === text.toLowerCase());
             if (matchedBtn) {
                 matchedEdge = edges.find(e => e.source === currentNodeId && e.sourceHandle === matchedBtn.id);
                 selectedValue = matchedBtn.id;
             }
        }

        if (currentNode.data.type === 'interactive_list' && currentNode.data.sections) {
            const allRows = currentNode.data.sections.flatMap((section: any) => section.rows || []);
            const matchedRow = allRows.find((row: any) => row.title?.toLowerCase() === text.toLowerCase());
            if (matchedRow) {
                matchedEdge = edges.find(e => e.source === currentNodeId && e.sourceHandle === matchedRow.id);
                selectedValue = matchedRow.id;
            }
        }

        if (currentNode.data.type === 'ask_image') {
            const requestedType = currentNode.data.requestedDocumentType || 'driving_license';
            if (imageUrl) {
                driver.documents = driver.documents || {};
                driver.documents[requestedType] = {
                    url: imageUrl,
                    type: 'image',
                    timestamp: Date.now()
                };
                driver.variables = driver.variables || {};
                driver.variables.document_status = 'uploaded';
                driver.variables.last_document_type = requestedType;
                driver.variables.last_document_uploaded_at = Date.now();
                selectedValue = imageUrl;
            } else {
                this.addMessage(driver.id, {
                    id: `${Date.now()}_retry`,
                    sender: 'system',
                    text: currentNode.data.retryMessage || 'Please upload a clear image to continue.',
                    timestamp: Date.now(),
                    type: 'text'
                });
                driver.currentBotStepId = currentNodeId;
                this.persist();
                return { driver, actionNeeded: 'NONE' };
            }
        }

        if (currentNode.data.variable) {
            driver.variables[currentNode.data.variable] = selectedValue || text;
        }

        if (matchedEdge) {
            nextNodeId = matchedEdge.target;
        } else {
            // Default path
            const edge = edges.find(e => e.source === currentNodeId && !e.sourceHandle);
            if (edge) nextNodeId = edge.target;
        }
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
        
        // Execute Node
        let msgType: any = 'text';
        if (data.type === 'interactive_button') msgType = 'interactive';
        if (data.type === 'interactive_list') msgType = 'interactive';
        if (data.type === 'ask_image') msgType = 'text';
        
        if (data.type === 'ask_image' && !data.content) {
            data.content = `Please upload your ${String(data.requestedDocumentType || 'document').replace(/_/g, ' ')} image.`;
        }

        if (data.content || data.mediaUrl) {
             this.addMessage(driver.id, {
                 id: Date.now().toString() + '_' + limit,
                 sender: 'system',
                 text: data.content,
                 imageUrl: data.mediaUrl,
                 timestamp: Date.now() + (10 - limit) * 100,
                 type: msgType
             });
        }

        // Wait Check
        if (['input', 'interactive_button', 'interactive_list', 'ask_image'].includes(data.type)) {
            driver.currentBotStepId = node.id;
            break; 
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
