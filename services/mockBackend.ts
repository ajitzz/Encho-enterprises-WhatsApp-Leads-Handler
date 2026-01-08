
import { Driver, LeadStatus, Message, OnboardingStep, LeadSource, BotSettings, BotStep } from '../types';

const ENCHO_SYSTEM_INSTRUCTION = `
Role: A friendly, helpful friend at Encho Cabs (Uber/Ola Fleet).
Language: Malayalam + simple English (Manglish).
Tone: Casual, Warm, Patient, Not "Salesy".

🌟 YOUR GOAL:
Build a relationship first. Let the driver ask questions. Do NOT push the job immediately.
You are here to *help* them decide if this is right for them. Give them space.

🛑 BEHAVIOR RULES:
1. **Be a Listener:** Answer ONLY what they ask. Don't add extra info unless it helps clarify.
2. **Give Space:** After answering, pause. Ask "Vere enthengilum ariyanundo?" (Do you want to know anything else?) instead of pushing for documents.
3. **Start Slow:** First message: Just say Hello and ask their name.
4. **Identify Concern:** 
   - Ask about Rent? -> Address cost worry (Mention performance bonus).
   - Ask about Stay? -> Address comfort worry (Mention Kitchen/Fridge).
   - Ask about Trust? -> Address safety worry (Mention Company Software).

🧠 CONVERSATION FLOW (FRIENDLY MODE):

[User: "Hi" / "Details?"]
AI: "Namaskaram! Encho Cabs-ilekku Swagatham. 😊 Enthaanu ariyuvan thalparyam? Or, adhyam ningalude peru parayamo?"

[User: "Ente peru Rahul. Details venam."]
AI: "Hi Rahul 👋. Njangal Uber & Ola connected fleet aanu. Rahul-inu ippol enthaanu pradhana aavishyam? Rent details aano, atho stay aano?" (Letting them choose the topic).

[User: "Rent ethraya?"]
AI: "Rent daily ₹600 aanu. Pakshe, daily 10 trips complete cheythaal rent **₹450 aayi kurayum**. Vere hidden charges onnum illa."

[User: "Room undo?"]
AI: "Und. Kitchen, Fridge, Washing Machine okke ulla nalla accommodation aanu njangal nalkunnath. Oru veedu pole thanne. Stay avishyamundo?"

[User: "Aah venam. Deposit undo?"]
AI: "Athe, ₹5000 refundable deposit und. Join cheyyan thalparyam undo?"

[User: "Yes"]
AI: "Santhosham! Verify cheyyan vendi License-inte oru photo ayakkamo?"

✨ KEY PSYCHOLOGY:
- Make them feel understood.
- If they complain about high rent elsewhere, say "Njangalude aduth angane alla" (It's not like that here).
- Use emojis to stay friendly.
`;

// Initial Bot Config
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
      title: 'License Check',
      message: 'നന്ദി! നിങ്ങളുടെ കൈയ്യിൽ valid ആയ Commercial Driving License ഉണ്ടോ?',
      inputType: 'option',
      options: ['ഉണ്ട് (Yes)', 'ഇല്ല (No)'],
      nextStepId: 'step_3',
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
      nextStepId: 'AI_HANDOFF' 
    }
  ],
  entryPointId: 'step_1'
};

// FIREWALL REGEX
const BLOCKED_REGEX = /replace\s+this\s+sample\s+message|enter\s+your\s+message|type\s+your\s+message\s+here|replace\s+this\s+text/i;

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
    isBotActive: false,
    notes: 'Initial inquiry via WhatsApp.'
  }
];

class MockBackendService {
  private drivers: Driver[] = [...MOCK_DRIVERS];
  private botSettings: BotSettings = { ...DEFAULT_BOT_SETTINGS };
  private listeners: (() => void)[] = [];

  constructor() {
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

  processIncomingMessage(phoneNumber: string, text: string, imageUrl?: string): { driver: Driver, reply?: Message, actionNeeded: 'NONE' | 'AI_REPLY' } {
    let driver = this.drivers.find((d) => d.phoneNumber === phoneNumber);
    let isNew = false;
    let settings = this.botSettings;

    const entryPointId = settings.entryPointId || settings.steps?.[0]?.id;

    if (!driver) {
      isNew = true;
      const shouldActivateBot = settings.isEnabled && settings.routingStrategy !== 'AI_ONLY';
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
        isBotActive: shouldActivateBot,
        currentBotStepId: entryPointId,
        notes: ''
      };
      this.drivers.push(driver);
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
                      text: "System is initializing. Please wait.",
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
              if (currentStep.saveToField === 'availability') driver.availability = text as any;
              if (currentStep.saveToField === 'document' && imageUrl) driver.documents.push(imageUrl);
              if (currentStep.saveToField === 'vehicleRegistration') driver.vehicleRegistration = text;
              
              if (currentStep.saveToField) {
                  const newNote = `[Bot] Captured ${currentStep.saveToField}: ${text}`;
                  driver.notes = driver.notes ? `${driver.notes}\n${newNote}` : newNote;
              }

              let nextId = currentStep.nextStepId;

              // --- MOCK BRANCHING LOGIC ---
              if (currentStep.routes && Object.keys(currentStep.routes).length > 0) {
                  const normalize = (str: string) => str.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
                  const cleanInput = normalize(text);
                  
                  // FIX: Sort keys by length descending to check specific (longer) matches first
                  const routeKey = Object.keys(currentStep.routes).sort((a, b) => b.length - a.length).find(k => {
                      const cleanKey = normalize(k);
                      if (cleanKey === cleanInput) return true;
                      if (cleanKey.length > 3 && cleanInput.length > 3) {
                          if (cleanKey.startsWith(cleanInput) || cleanInput.startsWith(cleanKey)) return true;
                      }
                      if (cleanInput.includes(cleanKey) && cleanKey.length > 2) return true;
                      return false;
                  });
                  
                  if (routeKey) {
                      nextId = currentStep.routes[routeKey];
                  } else {
                      const botMsg: Message = {
                          id: Date.now().toString() + '_bot',
                          sender: 'system',
                          text: "Please select one of the valid options below:",
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
                      text: nextId === 'AI_HANDOFF' ? "Thank you. We will contact you soon." : "Thank you! We have received your details.",
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
              let safeText = nextStep.message || (nextStep.options?.length ? "Select Option:" : "");
              
              // LINK LABEL SUPPORT
              if (nextStep.linkLabel && nextStep.message) {
                  safeText = `${nextStep.linkLabel}\n${nextStep.message}`;
              }

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
          } else {
               const errorMsg: Message = {
                  id: Date.now().toString() + '_err',
                  sender: 'system',
                  text: "Configuration Error: Next step is missing.",
                  timestamp: Date.now() + 500,
                  type: 'text'
              };
              this.addMessage(driver.id, errorMsg);
              driver.isBotActive = false;
              this.persist();
              return { driver, reply: errorMsg, actionNeeded: 'NONE' };
          }
        }
      }
    }

    return { driver, actionNeeded: 'NONE' };
  }

  createAdLead(name: string, phoneNumber: string): Driver {
    let driver = this.drivers.find((d) => d.phoneNumber === phoneNumber);
    if (driver) return driver;
    const settings = this.botSettings;
    const shouldActivateBot = settings.isEnabled && settings.routingStrategy !== 'AI_ONLY';
    const entryPointId = settings.entryPointId || settings.steps?.[0]?.id;

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
      isBotActive: shouldActivateBot,
      currentBotStepId: entryPointId,
      notes: 'Captured via Meta Ad Form.'
    };
    
    this.drivers.push(driver);
    this.persist();
    
    if (shouldActivateBot) {
        const firstStep = settings.steps.find(s => s.id === entryPointId) || settings.steps[0];
        if (firstStep) {
            setTimeout(() => {
                const isTemplate = !!firstStep.templateName;
                let safeText = firstStep.message || (firstStep.options?.length ? "Select Option:" : "");
                
                if (firstStep.linkLabel && firstStep.message) {
                    safeText = `${firstStep.linkLabel}\n${firstStep.message}`;
                }
                
                if (!safeText && !firstStep.mediaUrl && !isTemplate) return;

                this.addMessage(driver!.id, {
                    id: Date.now().toString() + '_auto',
                    sender: 'system',
                    text: isTemplate ? `[Template: ${firstStep.templateName}] ${name}!` : `Hi ${name}! ${safeText}`,
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
