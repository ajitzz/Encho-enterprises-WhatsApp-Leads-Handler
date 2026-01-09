
import { Driver, LeadStatus, Message, OnboardingStep, BotSettings, BotStep } from '../types';

const ENCHO_SYSTEM_INSTRUCTION = `
Role: Senior Support Executive at Encho Cabs (Uber/Ola Fleet).
Language: Malayalam mixed with simple English (Manglish). Professional but casual.
Goal: Answer Doubts -> Build Trust -> Schedule Call.
`;

const DEFAULT_BOT_SETTINGS: BotSettings = {
  isEnabled: true,
  routingStrategy: 'HYBRID_BOT_FIRST',
  systemInstruction: ENCHO_SYSTEM_INSTRUCTION,
  steps: [
    {
      id: 'step_1',
      title: 'Welcome & Name',
      message: 'നമസ്കാരം! Encho Cabs-ലേക്ക് സ്വാഗതം. നിങ്ങളുടെ പേര് പറയാമോ?',
      inputType: 'text',
      saveToField: 'name',
      nextStepId: 'step_2'
    },
    {
      id: 'step_2',
      title: 'Place & Contact',
      message: 'Hi! നാട്ടിൽ എവിടെയാണ്? കോൺടാക്ട് ചെയ്യാൻ പറ്റുന്ന ഒരു നമ്പർ കൂടി തന്നാൽ നന്നായിരുന്നു.',
      inputType: 'text',
      saveToField: 'vehicleRegistration',
      nextStepId: 'step_3'
    },
    {
      id: 'step_3',
      title: 'Open Doubts (Router)',
      message: 'നന്ദി! Encho Cabs-നെ കുറിച്ച് എന്തെങ്കിലും സംശയങ്ങൾ (Doubts) ഉണ്ടോ? 😊',
      inputType: 'text',
      nextStepId: 'step_4', 
      routes: { "no": "step_4", "illa": "step_4", "nothing": "step_4" }
    },
    {
      id: 'step_4',
      title: 'Hook 1: Software',
      message: 'ഞങ്ങളുടെ **Company Software**-നെ കുറിച്ച് അറിയാൻ താല്പര്യമുണ്ടോ? 📱',
      inputType: 'option',
      options: ['Yes, Parayu', 'No, Venda'],
      routes: { "yes": "step_5", "parayu": "step_5" },
      nextStepId: 'AI_HANDOFF'
    },
    {
      id: 'step_5',
      title: 'Hook 2: Bonus',
      message: 'ഞങ്ങളുടെ App-ൽ വരുമാനം കൃത്യമായി കാണാം! 🤝 അടുത്തത്, **Special Driver Bonus** 💰 പറയട്ടെ?',
      inputType: 'option',
      options: ['Yes, Parayu', 'No, Venda'],
      routes: { "yes": "step_6", "parayu": "step_6" },
      nextStepId: 'AI_HANDOFF'
    },
    {
      id: 'step_6',
      title: 'Hook 3: Freedom',
      message: 'Daily Target അടിച്ചാൽ Bata ലഭിക്കും! 💸 ഇനി, Encho-യിലെ **\'Own Boss\' Policy** 👑 കേൾക്കണോ?',
      inputType: 'option',
      options: ['Yes, Parayu', 'No, Venda'],
      routes: { "yes": "step_7", "parayu": "step_7" },
      nextStepId: 'AI_HANDOFF'
    },
    {
      id: 'step_7',
      title: 'Schedule Call',
      message: 'നിങ്ങൾക്ക് ഇഷ്ടമുള്ള സമയത്ത് വണ്ടി ഓടിക്കാം. 😎 വിശദമായി സംസാരിക്കാൻ, ഞങ്ങളുടെ എക്സിക്യൂട്ടീവ് എപ്പോഴാണ് വിളിക്കേണ്ടത്?',
      inputType: 'text',
      nextStepId: 'step_8'
    },
    {
      id: 'step_8',
      title: 'Confirmation',
      message: 'Sure, We will reach out to you soon. Thank you! 🤝',
      inputType: 'text',
      nextStepId: 'AI_HANDOFF'
    }
  ]
};

class MockBackendService {
  private drivers: Driver[] = [];
  private botSettings: BotSettings = { ...DEFAULT_BOT_SETTINGS };
  private listeners: (() => void)[] = [];

  constructor() {
    const saved = localStorage.getItem('uber_fleet_mock_v2');
    if (saved) this.drivers = JSON.parse(saved);
  }

  private persist() {
    localStorage.setItem('uber_fleet_mock_v2', JSON.stringify(this.drivers));
    this.notify();
  }

  private notify() { this.listeners.forEach(l => l()); }
  subscribe(l: () => void) { this.listeners.push(l); return () => { this.listeners = this.listeners.filter(i => i !== l); }; }
  getDrivers() { return [...this.drivers].sort((a,b) => b.lastMessageTime - a.lastMessageTime); }
  getBotSettings() { return this.botSettings; }
  updateBotSettings(s: BotSettings) { this.botSettings = s; this.notify(); }
  getDriver(id: string) { return this.drivers.find(d => d.id === id); }

  processIncomingMessage(phone: string, text: string, imageUrl?: string): { driver: Driver, actionNeeded: string } {
    let driver = this.drivers.find(d => d.phoneNumber === phone);
    const settings = this.botSettings;
    let actionNeeded = 'NONE';

    if (!driver) {
      driver = {
        id: Date.now().toString(),
        phoneNumber: phone,
        name: 'New Lead',
        source: 'Organic',
        status: LeadStatus.NEW,
        lastMessage: text,
        lastMessageTime: Date.now(),
        messages: [],
        documents: [],
        onboardingStep: OnboardingStep.WELCOME_SENT,
        qualificationChecks: { hasValidLicense: false, hasVehicle: false, isLocallyAvailable: true },
        isBotActive: settings.isEnabled && settings.routingStrategy !== 'AI_ONLY',
        currentBotStepId: settings.steps[0].id,
        notes: ''
      };
      this.drivers.push(driver);
    }

    const msg: Message = { 
      id: Date.now().toString(), 
      sender: 'driver', 
      text, 
      imageUrl,
      timestamp: Date.now(), 
      type: imageUrl ? 'image' : 'text' 
    };
    driver.messages.push(msg);
    driver.lastMessage = text;
    driver.lastMessageTime = Date.now();

    if (driver.isHumanMode) return { driver, actionNeeded };

    // --- INTERRUPTION LOGIC (Answer & Jump to Doubts) ---
    const QUESTION_REGEX = /([\?])|(rent|amount|salary|deposit|evide|entha|engane|location|details|doubt|rate)/i;
    const isQuestion = QUESTION_REGEX.test(text) && text.split(' ').length > 1; 
    const isStep3 = driver.currentBotStepId === 'step_3';

    // FIX: Only trigger AI interruption if NOT in Bot Only mode
    if (settings.routingStrategy !== 'BOT_ONLY' && settings.isEnabled && (isQuestion || (isStep3 && !text.toLowerCase().match(/^(no|illa|nothing|alla)$/)))) {
        const step3 = settings.steps.find(s => s.id === 'step_3');
        if (step3) {
            driver.currentBotStepId = 'step_3';
            setTimeout(() => {
                const followUp: Message = {
                    id: Date.now().toString() + '_follow',
                    sender: 'system',
                    text: step3.message,
                    timestamp: Date.now() + 2000,
                    type: 'text'
                };
                this.addMessage(driver!.id, followUp);
            }, 2000);
            this.persist();
            return { driver, actionNeeded: 'AI_REPLY' }; 
        }
    }

    // Strict linear logic for Bot Only
    if (driver.isBotActive && driver.currentBotStepId) {
      const step = settings.steps.find(s => s.id === driver!.currentBotStepId);
      if (step) {
          if (step.saveToField === 'name') driver.name = text;
          let nextId = step.nextStepId;
          if (step.routes) {
              const input = text.toLowerCase();
              const key = Object.keys(step.routes).find(k => input.includes(k));
              if (key) nextId = step.routes[key];
          }

          if (nextId && nextId !== 'AI_HANDOFF' && nextId !== 'END') {
              const nextStep = settings.steps.find(s => s.id === nextId);
              if (nextStep) {
                  driver.currentBotStepId = nextId;
                  setTimeout(() => {
                      this.addMessage(driver!.id, { id: Date.now().toString(), sender: 'system', text: nextStep.message, timestamp: Date.now(), type: 'text' });
                  }, 500);
              }
          } else {
              driver.isBotActive = false;
              if (nextId === 'AI_HANDOFF' && settings.routingStrategy !== 'BOT_ONLY') actionNeeded = 'AI_REPLY';
          }
      }
    }

    this.persist();
    return { driver, actionNeeded };
  }

  addMessage(driverId: string, msg: Message) {
    const d = this.drivers.find(i => i.id === driverId);
    if (d) { d.messages.push(msg); d.lastMessage = msg.text || ''; d.lastMessageTime = msg.timestamp; this.persist(); }
  }

  updateDriverDetails(id: string, u: Partial<Driver>) {
    const d = this.drivers.find(i => i.id === id);
    if (d) { Object.assign(d, u); this.persist(); }
  }
  
  updateDriverStatus(id: string, s: LeadStatus) { this.updateDriverDetails(id, { status: s }); }
  
  createAdLead(name: string, phone: string) {
    const d = this.processIncomingMessage(phone, "Interested").driver;
    d.name = name;
    d.source = 'Meta Ad';
    this.persist();
    return d;
  }
}

export const mockBackend = new MockBackendService();
