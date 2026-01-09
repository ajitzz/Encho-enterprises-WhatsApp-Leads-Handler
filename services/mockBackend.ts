
import { Driver, LeadStatus, Message, OnboardingStep, LeadSource, BotSettings, BotStep } from '../types';

const ENCHO_SYSTEM_INSTRUCTION = `
Role: Senior Support Executive at Encho Cabs (Uber/Ola Fleet Kerala).
Language: Malayalam mixed with simple English (Manglish). Professional, warm, and trustworthy.
Goal: Clarify doubts -> Build Confidence -> Schedule a Call.

🛑 CONVERSATION RULES:
1. **Answer First:** If the user asks a specific question (e.g., "Rent amount?", "Car model?"), answer that FIRST.
   - Keep answers concise and clear.
2. **Redirect to Flow:** After answering, do not leave the conversation open. Always ask: "Vere enthengilum doubts undo?" (Any other doubts?) or guide them back to the features.
3. **The "Trust Chain" Strategy:** We sell the fleet based on 3 pillars. If appropriate, mention these:
   - **Software:** Transparency in bills/earnings.
   - **Bonus:** Daily Bata & Monthly Incentives.
   - **Freedom:** No fixed shifts. Own Boss.
4. **Closing Protocol:**
   - If they are interested/ready, ask for a call time: "When should our executive call you to explain details?"
   - If they provide a time (e.g., "Today evening", "Tomorrow 10am"), REPLY EXACTLY: "Sure, We will reach out to you soon. Thank you! 🤝"

🧠 KNOWLEDGE BASE (Strict Facts):
- **Vehicle:** Maruti WagonR CNG (Company maintained).
- **Rent:** ₹600/day. (Special Offer: If daily target is met, Rent becomes ₹450/day).
- **Deposit:** ₹5000 (Refundable).
- **Requirements:** Valid License, Local Address Proof.
- **Software:** "Drivers-inu vendi ulla transparency system. Earnings and Bills app-il kaanam."

✨ TONE:
- Use emojis naturally (👋, 😊, 🚗, 💸).
- Be polite but confident.
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
      message: 'നമസ്കാരം! Encho Cabs-ലേക്ക് സ്വാഗതം. ഞങ്ങൾ Uber/Ola connected fleet ആണ്. നിങ്ങളുടെ പേര് പറയാമോ?',
      inputType: 'text',
      saveToField: 'name',
      nextStepId: 'step_2'
    },
    {
      id: 'step_2',
      title: 'Place & Contact',
      message: 'Hi! നാട്ടിൽ എവിടെയാണ്? നിങ്ങളെ കോൺടാക്ട് ചെയ്യാൻ പറ്റുന്ന ഒരു നമ്പർ കൂടി തന്നാൽ നന്നായിരുന്നു.',
      inputType: 'text',
      saveToField: 'vehicleRegistration',
      nextStepId: 'step_3'
    },
    {
      id: 'step_3',
      title: 'Open Doubts (Router)',
      message: 'നന്ദി! Details നോട്ട് ചെയ്തിട്ടുണ്ട്. Encho Cabs-നെ കുറിച്ച് എന്തെങ്കിലും സംശയങ്ങൾ (Doubts) ഉണ്ടോ? ചോദിച്ചോളൂ, ഞാൻ പറഞ്ഞുതരാം. 😊',
      inputType: 'text',
      nextStepId: 'step_4', 
      routes: {
          "no": "step_4",
          "illa": "step_4",
          "nothing": "step_4",
          "alla": "step_4"
      }
    },
    {
      id: 'step_4',
      title: 'Hook 1: Software',
      message: 'ഒരു കാര്യം കൂടി, ഞങ്ങളുടെ **Company Software**-നെ കുറിച്ച് അറിയാൻ താല്പര്യമുണ്ടോ? 📱 ഡ്രൈവർമാർക്ക് വേണ്ടിയുള്ള സുതാര്യമായ (Transparent) സിസ്റ്റം ആണിത്.',
      inputType: 'option',
      options: ['Yes, Parayu', 'No, Venda'],
      routes: { "yes": "step_5", "parayu": "step_5" },
      nextStepId: 'AI_HANDOFF'
    },
    {
      id: 'step_5',
      title: 'Explain Software + Hook 2: Bonus',
      message: 'ഞങ്ങളുടെ App-ൽ നിങ്ങൾക്ക് ഡെയിലി ബില്ലും ഏണിങ്സും കൃത്യമായി കാണാം. കണക്കിൽ ഒരു രൂപയുടെ പോലും വ്യത്യാസം ഉണ്ടാവില്ല! 🤝\n\nഅടുത്തത്, ഞങ്ങളുടെ **Special Driver Bonus**-ine 💰 കുറിച്ച് പറയട്ടെ?',
      inputType: 'option',
      options: ['Yes, Parayu', 'No, Venda'],
      routes: { "yes": "step_6", "parayu": "step_6" },
      nextStepId: 'AI_HANDOFF'
    },
    {
      id: 'step_6',
      title: 'Explain Bonus + Hook 3: Freedom',
      message: 'Daily Target അടിച്ചാൽ അധിക വരുമാനം (Bata) ലഭിക്കും! കൂടാതെ കൃത്യമായി വണ്ടി ഓടിക്കുന്നവർക്ക് Monthly Performance Bonus-ഉം ഉണ്ട്. 💸\n\nഇനി, Encho-യിലെ **\'Own Boss\' Policy**-ye 👑 കുറിച്ച് കേൾക്കണോ?',
      inputType: 'option',
      options: ['Yes, Parayu', 'No, Venda'],
      routes: { "yes": "step_7", "parayu": "step_7" },
      nextStepId: 'AI_HANDOFF'
    },
    {
      id: 'step_7',
      title: 'Explain Freedom + Schedule Call',
      message: 'ഞങ്ങൾക്ക് ഫിക്സഡ് ഷിഫ്റ്റ് ഇല്ല! നിങ്ങൾക്ക് ഇഷ്ടമുള്ള സമയത്ത് ലോഗിൻ ചെയ്യാം. You are your own boss! 😎\n\nവിശദമായി സംസാരിക്കാൻ, ഞങ്ങളുടെ എക്സിക്യൂട്ടീവ് നിങ്ങളെ എപ്പോഴാണ് വിളിക്കേണ്ടത്? (When should we call you?)',
      inputType: 'text',
      nextStepId: 'step_8'
    },
    {
      id: 'step_8',
      title: 'Closing Confirmation',
      message: 'Sure, We will reach out to you soon. Thank you! 🤝',
      inputType: 'text',
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

    // --- INTERRUPTION LOGIC (Answer & Jump to Doubts) ---
    // Detect Question Keywords
    const QUESTION_REGEX = /([\?])|(rent|amount|salary|deposit|evide|entha|engane|location|details|doubt|rate)/i;
    const isQuestion = QUESTION_REGEX.test(text) && text.split(' ').length > 1; 
    const isStep3 = driver.currentBotStepId === 'step_3';

    // Interrupt if it's a question AND (we are not at Step 3 OR we are at Step 3 but it's not a "No" answer)
    if (settings.isEnabled && (isQuestion || (isStep3 && !text.toLowerCase().match(/^(no|illa|nothing|alla)$/)))) {
        // Return Action Needed for AI Reply + State Force
        // Mocking the AI interruption response here since `processIncomingMessage` is sync in mock
        const step3 = settings.steps.find(s => s.id === 'step_3');
        if (step3) {
            driver.currentBotStepId = 'step_3';
            // We tell the simulator to fire AI, but also we need to queue the Step 3 message
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
            return { driver, actionNeeded: 'AI_REPLY' }; // Simulator will trigger AI generation for the answer
        }
    }


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
