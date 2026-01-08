
import { Lead, LeadStatus, Message, OnboardingStep, LeadSource, BotSettings, BotStep } from '../types';

// --- PERSONA 1: ENCHO CABS (Malayalam/Manglish) ---
const ENCHO_CABS_SYSTEM_INSTRUCTION = `
Role:
You are a WhatsApp Customer Support Executive for **Encho Cabs** (Uber + Ola connected fleet).
You must respond in **Malayalam + simple English (mixed/Manglish)**.
Keep responses short (2-4 lines), friendly, and human-like.
If the driver speaks Tamil/Hindi/English, switch language immediately.

**CORE GOAL:** Explain benefits clearly and get their Name & Phone Number for a visit.

✅ **COMPANY FACTS (Encho Cabs):**
- **Company:** Encho Cabs (Uber + Ola connected).
- **Vehicle:** WagonR CNG (latest manual). Safe & Well-maintained.
- **Accommodation:** ₹5000 refundable deposit (after 4 months). Includes Kitchen, Bed, Mattress, Heater, Vessels, Fridge, Washing Machine.
- **Rent:** ₹600/day for 10 trips. (Weekly target 70 trips).
- **Performance Bonus:** Good performance → Rent reduces to ₹550 → ₹500 → ₹450.
- **Earnings:** Week 1 avg ₹18,000. Experienced: ₹23,000/week.
- **Commissions:** We take **NO commission** from earnings. Only daily rent.
- **Expenses:** CNG (~₹650/day). Uber fee (~₹400 per ₹3000 earning).
- **Leave:** Mondays only. Inform 10 days before.
- **Software (New):** We provide a Company App for drivers. All payments, trip calculations, and weekly bills are visible there. 100% Transparency. You can download bills directly. No cheating, fully digital trust.

✅ **RESPONSE RULES:**
1. Default length: 2–4 lines.
2. If asked "Details?", reply 6–10 lines max.
3. Always ask **one question** at the end (e.g., "Interested ആണോ?", "പേര് പറയാമോ?").
`;

// --- PERSONA 2: ENCHO TRAVEL (English/Professional) ---
const ENCHO_TRAVEL_SYSTEM_INSTRUCTION = `
Role:
You are a Travel Consultant for **Encho Travels** (Luxury & Outstation Packages).
You must respond in **Professional English**.
Tone: Exciting, Helpful, Polite.

**CORE GOAL:** Help customers plan trips and book packages.

✅ **COMPANY FACTS (Encho Travel):**
- **Services:** Outstation trips, Weekend Getaways, Airport Transfers, Pilgrimage Packages.
- **Vehicles:** Innova Crysta, Tempo Traveller, Urbania.
- **Drivers:** Verified, Uniformed, Multilingual.
- **Safety:** GPS Tracking, 24/7 Support.
- **Pricing:** Transparent per/km pricing. No hidden driver batta charges.

✅ **RESPONSE RULES:**
1. Be polite and professional.
2. Ask for: Destination, Dates, and Group Size.
`;

// --- DEFAULT SETTINGS MAP ---
const SETTINGS_CABS: BotSettings = {
  companyId: '1',
  isEnabled: true,
  routingStrategy: 'HYBRID_BOT_FIRST',
  systemInstruction: ENCHO_CABS_SYSTEM_INSTRUCTION,
  steps: [
    {
      id: 'step_1',
      title: 'Welcome & Intro',
      message: 'നമസ്കാരം 👋 Encho Cabs-ലേക്ക് സ്വാഗതം! \nഞങ്ങൾ Uber/Ola connected fleet ആണ്. \n\nWagonR CNG വണ്ടിയും താമസസൗകര്യവും (Accommodation) ഞങ്ങൾ നൽകുന്നുണ്ട്. \n\nതാങ്കളുടെ പേര് ഒന്ന് പറയാമോ?',
      inputType: 'text',
      saveToField: 'name',
      nextStepId: 'step_2'
    },
    {
      id: 'step_2',
      title: 'License Check',
      message: 'നന്ദി! താങ്കളുടെ കൈയ്യിൽ valid ആയ Driving License (Badge) ഉണ്ടോ?',
      inputType: 'option',
      options: ['ഉണ്ട് (Yes)', 'ഇല്ല (No)', 'Expired'],
      nextStepId: 'step_3',
      routes: { 'ഇല്ല (No)': 'END', 'Expired': 'END' }
    },
    {
      id: 'step_3',
      title: 'Software & Rent',
      message: 'Great. Rent ₹600/day (10 trips). \n\nഞങ്ങൾക്ക് സ്വന്തമായി **Driver App** ഉണ്ട്. Payment, calculations എല്ലാം അതിൽ കൃത്യമായി കാണാം (100% Transparency). \n\nVisit ചെയ്യാൻ താല്പര്യമുണ്ടോ?',
      inputType: 'option',
      options: ['Yes, Visit', 'More Details'],
      nextStepId: 'AI_HANDOFF' 
    }
  ],
  entryPointId: 'step_1'
};

const SETTINGS_TRAVEL: BotSettings = {
  companyId: '2',
  isEnabled: true,
  routingStrategy: 'AI_ONLY', // Travel implies complex queries
  systemInstruction: ENCHO_TRAVEL_SYSTEM_INSTRUCTION,
  steps: [], // AI handle it
  entryPointId: 'step_1'
};

// FIREWALL REGEX
const BLOCKED_REGEX = /replace\s+this\s+sample\s+message|enter\s+your\s+message|type\s+your\s+message\s+here|replace\s+this\s+text/i;

// Initial Mock Data
const MOCK_LEADS: Lead[] = [
  {
    id: '1',
    companyId: '1',
    phoneNumber: '+91 98765 43210',
    name: 'Rajesh Kumar',
    source: 'Organic',
    status: LeadStatus.NEW,
    lastMessage: 'Details please?',
    lastMessageTime: Date.now() - 1000 * 60 * 60 * 2,
    messages: [
      { id: 'msg_1', sender: 'driver', text: 'Details please?', timestamp: Date.now() - 1000 * 60 * 60 * 2, type: 'text' },
    ],
    documents: [],
    onboardingStep: OnboardingStep.WELCOME_SENT,
    qualificationChecks: { check1: false, check2: false, check3: true },
    isBotActive: false,
    notes: 'Asked about rent details.'
  },
  {
    id: '2',
    companyId: '2',
    phoneNumber: '+91 99999 88888',
    name: 'Sarah Jones',
    source: 'Meta Ad',
    status: LeadStatus.NEW,
    lastMessage: 'Looking for Munnar trip',
    lastMessageTime: Date.now() - 1000 * 60 * 30,
    messages: [
      { id: 'msg_2', sender: 'driver', text: 'Looking for Munnar trip for 3 days.', timestamp: Date.now() - 1000 * 60 * 30, type: 'text' },
    ],
    documents: [],
    onboardingStep: OnboardingStep.WELCOME_SENT,
    qualificationChecks: { check1: false, check2: false, check3: false },
    isBotActive: true,
    notes: 'Potential high value customer'
  }
];

class MockBackendService {
  private leads: Lead[] = [...MOCK_LEADS];
  private currentCompanyId = '1';
  private settingsMap: Record<string, BotSettings> = {};
  private listeners: (() => void)[] = [];

  constructor() {
    // Initialize Defaults
    this.settingsMap['1'] = { ...SETTINGS_CABS };
    this.settingsMap['2'] = { ...SETTINGS_TRAVEL };

    // Load Persistence
    const savedDrivers = localStorage.getItem('uber_fleet_drivers_v2');
    const savedSettings = localStorage.getItem('uber_fleet_bot_settings_v2');
    
    if (savedDrivers) {
      try { this.leads = JSON.parse(savedDrivers); } catch (e) {}
    }
    if (savedSettings) {
      try { 
          const parsed = JSON.parse(savedSettings);
          // Merge saved with defaults (to ensure instructions update if code changes)
          this.settingsMap = { ...this.settingsMap, ...parsed };
          
          // Force update instructions from code to apply new prompt updates
          if (this.settingsMap['1']) this.settingsMap['1'].systemInstruction = ENCHO_CABS_SYSTEM_INSTRUCTION;
          if (this.settingsMap['2']) this.settingsMap['2'].systemInstruction = ENCHO_TRAVEL_SYSTEM_INSTRUCTION;

      } catch (e) {}
    }
  }

  setCompanyId(id: string) {
      this.currentCompanyId = id;
      this.notify();
  }

  private persist() {
    localStorage.setItem('uber_fleet_drivers_v2', JSON.stringify(this.leads));
    localStorage.setItem('uber_fleet_bot_settings_v2', JSON.stringify(this.settingsMap));
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

  getDrivers(): Lead[] {
    // MULTI-TENANT FILTER
    return this.leads
        .filter(d => d.companyId === this.currentCompanyId)
        .sort((a, b) => b.lastMessageTime - a.lastMessageTime);
  }

  getBotSettings(): BotSettings {
    if (!this.settingsMap[this.currentCompanyId]) {
        // Create generic default for unknown companies
        this.settingsMap[this.currentCompanyId] = {
            companyId: this.currentCompanyId,
            isEnabled: true,
            routingStrategy: 'AI_ONLY',
            systemInstruction: 'You are a helpful assistant.',
            steps: []
        };
    }
    return this.settingsMap[this.currentCompanyId];
  }

  updateBotSettings(settings: BotSettings) {
    this.settingsMap[this.currentCompanyId] = settings;
    this.persist();
  }

  getDriver(id: string): Lead | undefined {
    return this.leads.find((d) => d.id === id); // ID is unique globally
  }

  addMessage(driverId: string, message: Message) {
    const driverIndex = this.leads.findIndex((d) => d.id === driverId);
    if (driverIndex > -1) {
      const driver = this.leads[driverIndex];
      driver.messages.push(message);
      driver.lastMessage = message.type === 'image' ? '[Image Sent]' : (message.text || 'Media');
      driver.lastMessageTime = message.timestamp;
      
      if (message.type === 'image' && message.sender === 'driver') {
         driver.documents.push(message.imageUrl || '');
         driver.onboardingStep = Math.max(driver.onboardingStep, OnboardingStep.DOCUMENTS_RECEIVED);
      }

      this.leads[driverIndex] = { ...driver };
      this.persist();
    }
  }

  updateDriverDetails(driverId: string, updates: Partial<Lead>) {
    const driverIndex = this.leads.findIndex((d) => d.id === driverId);
    if (driverIndex > -1) {
      this.leads[driverIndex] = { ...this.leads[driverIndex], ...updates };
      this.persist();
    }
  }

  updateDriverStatus(driverId: string, status: LeadStatus) {
    const driver = this.leads.find((d) => d.id === driverId);
    if (driver) {
      driver.status = status;
      this.persist();
    }
  }

  // --- BOT ENGINE ---

  processIncomingMessage(phoneNumber: string, text: string, imageUrl?: string): { driver: Lead, reply?: Message, actionNeeded: 'NONE' | 'AI_REPLY' } {
    // Find driver ONLY in current company
    let driver = this.leads.find((d) => d.phoneNumber === phoneNumber && d.companyId === this.currentCompanyId);
    let isNew = false;
    let settings = this.getBotSettings();

    // --- MOCK SANITIZATION ---
    if (settings.steps) {
        settings.steps = settings.steps.map(s => {
             const m = s.message || "";
             if (BLOCKED_REGEX.test(m)) {
                 if (s.options && s.options.length > 0) s.message = "Please select an option:";
                 else s.message = ""; 
             }
             return s;
        });
    }

    const entryPointId = settings.entryPointId || settings.steps?.[0]?.id;

    if (!driver) {
      isNew = true;
      const shouldActivateBot = settings.isEnabled && settings.routingStrategy !== 'AI_ONLY';
      driver = {
        id: Date.now().toString(),
        companyId: this.currentCompanyId, // Strict Tenant ID
        phoneNumber,
        name: 'Unknown User',
        source: 'Organic',
        status: LeadStatus.NEW,
        lastMessage: '',
        lastMessageTime: Date.now(),
        messages: [],
        documents: [],
        onboardingStep: OnboardingStep.WELCOME_SENT,
        qualificationChecks: { check1: false, check2: false, check3: true },
        isBotActive: shouldActivateBot,
        currentBotStepId: entryPointId,
        notes: ''
      };
      this.leads.push(driver);
    }

    const userMsg: Message = {
      id: Date.now().toString(),
      sender: 'driver',
      text: text,
      imageUrl: imageUrl,
      timestamp: Date.now(),
      type: imageUrl ? 'image' : 'text',
    };
    this.addMessage(driver.id, userMsg);

    // HUMAN OVERRIDE
    if (driver.isHumanMode) return { driver, actionNeeded: 'NONE' };

    if (settings.isEnabled && settings.routingStrategy === 'AI_ONLY') {
      return { driver, actionNeeded: 'AI_REPLY' };
    }

    if (settings.isEnabled) {
      if (!driver.isBotActive) {
          if (settings.routingStrategy === 'BOT_ONLY') {
              if (entryPointId) {
                  driver.isBotActive = true;
                  driver.currentBotStepId = entryPointId;
                  isNew = true; 
                  this.persist();
              } else {
                  // Fallback for empty bot
                  const maintenanceMsg: Message = {
                      id: Date.now().toString() + '_maint',
                      sender: 'system',
                      text: "ഞങ്ങളുടെ സിസ്റ്റം അപ്ഡേറ്റ് ചെയ്യുകയാണ്. ദയവായി അല്പസമയം കഴിഞ്ഞ് മെസ്സേജ് അയക്കുക.",
                      timestamp: Date.now() + 500,
                      type: 'text'
                  };
                  this.addMessage(driver.id, maintenanceMsg);
                  return { driver, reply: maintenanceMsg, actionNeeded: 'NONE' };
              }
          }
          else if (settings.routingStrategy === 'HYBRID_BOT_FIRST') {
              return { driver, actionNeeded: 'AI_REPLY' };
          }
      }

      if (driver.isBotActive && driver.currentBotStepId) {
        let currentStep = settings.steps.find(s => s.id === driver.currentBotStepId);
        
        // Fallback for deleted steps
        if (!currentStep && settings.steps.length > 0) {
             const firstId = entryPointId || settings.steps[0].id;
             driver.currentBotStepId = firstId;
             currentStep = settings.steps.find(s => s.id === firstId);
             isNew = true; 
        }
        
        if (currentStep) {
          if (!isNew) { 
              if (currentStep.saveToField === 'name') driver.name = text;
              if (currentStep.saveToField === 'customField2') driver.customField2 = text;
              if (currentStep.saveToField === 'document' && imageUrl) driver.documents.push(imageUrl);
              if (currentStep.saveToField === 'customField1') driver.customField1 = text;
              
              if (currentStep.saveToField) {
                  const newNote = `[Bot] Captured ${currentStep.saveToField}: ${text}`;
                  driver.notes = driver.notes ? `${driver.notes}\n${newNote}` : newNote;
              }

              let nextId = currentStep.nextStepId;

              // --- MOCK BRANCHING LOGIC ---
              if (currentStep.routes && Object.keys(currentStep.routes).length > 0) {
                  const cleanInput = text.trim().toLowerCase();
                  const routeKey = Object.keys(currentStep.routes).find(k => {
                      const cleanKey = k.toLowerCase();
                      return cleanKey === cleanInput || cleanKey.startsWith(cleanInput) || cleanInput.startsWith(cleanKey);
                  });
                  
                  if (routeKey) {
                      nextId = currentStep.routes[routeKey];
                  } else {
                      const botMsg: Message = {
                          id: Date.now().toString() + '_bot',
                          sender: 'system',
                          text: "ദയവായി താഴെയുള്ള ഓപ്ഷനുകളിൽ ഒന്ന് തിരഞ്ഞെടുക്കുക:",
                          timestamp: Date.now() + 500,
                          type: 'options',
                          options: currentStep.options
                      };
                      this.addMessage(driver.id, botMsg);
                      return { driver, reply: botMsg, actionNeeded: 'NONE' };
                  }
              }

              if (nextId === 'END' || nextId === 'AI_HANDOFF' || !nextId) {
                  driver.isBotActive = false;
                  driver.currentBotStepId = undefined;
                  this.persist();
                  
                  if (nextId === 'AI_HANDOFF' && settings.routingStrategy === 'HYBRID_BOT_FIRST') {
                      return { driver, actionNeeded: 'AI_REPLY' };
                  }
                  
                  const endMsg: Message = {
                      id: Date.now().toString() + '_end',
                      sender: 'system',
                      text: nextId === 'AI_HANDOFF' ? "നന്ദി. കൂടുതൽ വിവരങ്ങൾക്കായി ഞാൻ ഇപ്പോൾ കണക്ട് ചെയ്യാം." : "നന്ദി! വിവരങ്ങൾ ലഭിച്ചു. ഞങ്ങൾ ഉടൻ ബന്ധപ്പെടാം.",
                      timestamp: Date.now() + 500,
                      type: 'text'
                  };
                  this.addMessage(driver.id, endMsg);
                  return { driver, reply: endMsg, actionNeeded: 'NONE' };

              } else {
                  driver.currentBotStepId = nextId;
              }
          }

          const nextStep = settings.steps.find(s => s.id === driver.currentBotStepId);
          if (nextStep) {
              const safeText = nextStep.message || (nextStep.options?.length ? "Select Option:" : "");
              if (!safeText && !nextStep.mediaUrl && !nextStep.templateName) {
                  return { driver, actionNeeded: 'NONE' };
              }

              const botMsg: Message = {
                  id: Date.now().toString() + '_bot',
                  sender: 'system',
                  text: nextStep.templateName ? `[Template: ${nextStep.templateName}] ${safeText}` : safeText,
                  timestamp: Date.now() + 500,
                  type: nextStep.templateName ? 'template' : (nextStep.options && nextStep.options.length > 0 ? 'options' : (nextStep.mediaUrl ? 'image' : 'text')),
                  options: nextStep.options,
                  imageUrl: nextStep.mediaUrl
              };
              this.addMessage(driver.id, botMsg);
              this.persist();
              return { driver, reply: botMsg, actionNeeded: 'NONE' };
          }
        }
      }
    }

    return { driver, actionNeeded: 'NONE' };
  }

  createAdLead(name: string, phoneNumber: string): Lead {
    // Check in CURRENT company
    let driver = this.leads.find((d) => d.phoneNumber === phoneNumber && d.companyId === this.currentCompanyId);
    if (driver) return driver;
    
    const settings = this.getBotSettings();
    const shouldActivateBot = settings.isEnabled && settings.routingStrategy !== 'AI_ONLY';
    const entryPointId = settings.entryPointId || settings.steps?.[0]?.id;

    driver = {
      id: Date.now().toString(),
      companyId: this.currentCompanyId,
      phoneNumber,
      name,
      source: 'Meta Ad',
      status: LeadStatus.NEW,
      lastMessage: 'Lead Created from Ad',
      lastMessageTime: Date.now(),
      messages: [],
      documents: [],
      onboardingStep: OnboardingStep.WELCOME_SENT,
      qualificationChecks: { check1: false, check2: false, check3: true },
      isBotActive: shouldActivateBot,
      currentBotStepId: entryPointId,
      notes: 'Captured via Meta Ad Form.'
    };
    
    this.leads.push(driver);
    this.persist();
    
    if (shouldActivateBot) {
        const firstStep = settings.steps.find(s => s.id === entryPointId) || settings.steps[0];
        if (firstStep) {
            setTimeout(() => {
                const isTemplate = !!firstStep.templateName;
                const safeText = firstStep.message || (firstStep.options?.length ? "Select Option:" : "");
                
                if (!safeText && !firstStep.mediaUrl && !isTemplate) return;

                this.addMessage(driver!.id, {
                    id: Date.now().toString() + '_auto',
                    sender: 'system',
                    text: isTemplate ? `[Template: ${firstStep.templateName}] Hi ${name}!` : `Hi ${name}! ${safeText}`,
                    type: isTemplate ? 'template' : (firstStep.options && firstStep.options.length > 0 ? 'options' : (firstStep.mediaUrl ? 'image' : 'text')),
                    options: firstStep.options,
                    imageUrl: firstStep.mediaUrl,
                    timestamp: Date.now()
                });
            }, 500);
        }
    }

    return driver;
  }
}

export const mockBackend = new MockBackendService();
