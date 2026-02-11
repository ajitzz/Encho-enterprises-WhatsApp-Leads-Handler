
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

  private interpolateTemplate(template: string, variables: Record<string, any>) {
    return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => {
      const value = variables[key];
      return value === undefined || value === null || value === '' ? '—' : String(value);
    });
  }

  private resolveNodeVariableName(node: any) {
    const explicit = String(node?.data?.variable || '').trim();
    if (explicit) return explicit;

    const fallbackByType: Record<string, string> = {
      pickup_location: 'pickup_coords',
      destination_location: 'destination_coords',
      location_request: 'live_location',
      datetime_picker: 'pickup_time',
      interactive_button: 'selected_option',
      interactive_list: 'selected_menu_option'
    };

    return fallbackByType[node?.data?.type] || '';
  }

  private saveNodeResponse(driver: Driver, node: any, text: string) {
    const nodeType = node?.data?.type;
    const variableName = this.resolveNodeVariableName(node);
    if (!variableName) return;

    if (['input', 'interactive_button', 'interactive_list', 'datetime_picker', 'pickup_location', 'destination_location', 'location_request'].includes(nodeType)) {
      driver.variables[variableName] = text;
    }
  }

  private buildSummaryMessage(data: any, variables: Record<string, any>) {
    const style = data.summaryStyle || 'card';
    const configuredRows = (data.summaryVariables || []) as Array<{ variable: string; label?: string; emoji?: string }>;
    const rows = configuredRows.length
      ? configuredRows
      : Object.keys(variables || {}).map((key) => ({ variable: key, label: key.replace(/_/g, ' ') }));

    const formattedRows = rows
      .filter((row) => row.variable)
      .map((row) => {
        const value = variables[row.variable];
        const safeValue = value === undefined || value === null || value === '' ? '—' : String(value);
        const prefix = row.emoji || (style === 'compact' ? '•' : '▪️');
        return `${prefix} *${row.label || row.variable}:* ${safeValue}`;
      });

    const header = this.interpolateTemplate(data.content || 'Summary', variables);
    const footer = this.interpolateTemplate(data.footerText || '', variables);

    if (style === 'compact') {
      return [header, ...formattedRows, footer].filter(Boolean).join('\n');
    }

    if (style === 'clean') {
      return [
        `*${header}*`,
        ...formattedRows,
        footer
      ].filter(Boolean).join('\n');
    }

    return [
      '┏━━━ 📋 *Summary* ━━━',
      `┃ ${header}`,
      '┣━━━━━━━━━━━━━━━━━━',
      ...formattedRows.map((line) => `┃ ${line}`),
      ...(footer ? ['┣━━━━━━━━━━━━━━━━━━', `┃ ${footer}`] : []),
      '┗━━━━━━━━━━━━━━━━━━'
    ].join('\n');
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
        this.saveNodeResponse(driver, currentNode, text);

        // Mocking Button/List Logic: 
        // In simulation, we assume if the user types something similar to a button title, they clicked it.
        // Or if they type 'btn_...' (debug id).
        
        let matchedEdge = null;
        
        if (currentNode.data.type === 'interactive_button' && currentNode.data.buttons) {
             const matchedBtn = currentNode.data.buttons.find((b: any) => b.title.toLowerCase() === text.toLowerCase());
             if (matchedBtn) {
                 matchedEdge = edges.find(e => e.source === currentNodeId && e.sourceHandle === matchedBtn.id);
             }
        }

        if (currentNode.data.type === 'interactive_list' && currentNode.data.sections) {
             const allRows = currentNode.data.sections.flatMap((section: any) => section.rows || []);
             const matchedRow = allRows.find((row: any) => row.title.toLowerCase() === text.toLowerCase());
             if (matchedRow) {
                 matchedEdge = edges.find(e => e.source === currentNodeId && e.sourceHandle === matchedRow.id);
             }
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
        
        if (data.content || data.mediaUrl || data.type === 'summary') {
             const renderedText = data.type === 'summary'
               ? this.buildSummaryMessage(data, driver.variables || {})
               : this.interpolateTemplate(data.content || '', driver.variables || {});

             this.addMessage(driver.id, {
                 id: Date.now().toString() + '_' + limit,
                 sender: 'system',
                 text: renderedText,
                 imageUrl: data.mediaUrl,
                 timestamp: Date.now() + (10 - limit) * 100,
                 type: msgType
             });
        }

        // Wait Check
        if (['input', 'interactive_button', 'interactive_list'].includes(data.type)) {
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
