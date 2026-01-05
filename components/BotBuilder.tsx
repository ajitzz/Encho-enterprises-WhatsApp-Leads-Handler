import React, { useState, useEffect, useRef } from 'react';
import { BotSettings, BotStep } from '../types';
import { mockBackend } from '../services/mockBackend';
import { liveApiService } from '../services/liveApiService';
import { analyzeMessage } from '../services/geminiService';
import { 
  Save, Plus, Trash2, BrainCircuit, MessageSquare, Settings2, 
  Sparkles, AlertCircle, Play, X, Send, Bot as BotIcon, 
  List, Image as ImageIcon, Type, ArrowDown, GripVertical, FileCode
} from 'lucide-react';

// Default prop in case parent doesn't provide it
interface BotBuilderProps {
    isLiveMode?: boolean; 
}

export const BotBuilder: React.FC<BotBuilderProps> = ({ isLiveMode = false }) => {
  const [settings, setSettings] = useState<BotSettings>(mockBackend.getBotSettings());
  const [activeStepId, setActiveStepId] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState('');

  // Test Mode State
  const [showTestModal, setShowTestModal] = useState(false);
  const [testMessages, setTestMessages] = useState<{id: number, sender: 'user' | 'system', text: string, options?: string[]}[]>([]);
  const [testInput, setTestInput] = useState('');
  const [testCurrentStepId, setTestCurrentStepId] = useState<string | null>(null);
  const [testIsAiActive, setTestIsAiActive] = useState(false); // Track if AI has taken over in test
  const [isTestTyping, setIsTestTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const loadSettings = async () => {
        if (isLiveMode) {
            try {
                const liveSettings = await liveApiService.getBotSettings();
                setSettings(liveSettings);
                if (liveSettings.steps.length > 0) setActiveStepId(liveSettings.steps[0].id);
            } catch (e) {
                setLoadError("Could not load live settings. Ensure server is running.");
            }
        } else {
            setSettings(mockBackend.getBotSettings());
            const mockSet = mockBackend.getBotSettings();
            if (mockSet.steps.length > 0) setActiveStepId(mockSet.steps[0].id);
        }
    };
    loadSettings();
  }, [isLiveMode]);

  // Scroll to bottom of test chat
  useEffect(() => {
    if (showTestModal) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [testMessages, showTestModal, isTestTyping]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
        if (isLiveMode) {
            await liveApiService.saveBotSettings(settings);
        } else {
            mockBackend.updateBotSettings(settings);
        }
        // Minimal delay for UX
        setTimeout(() => setIsSaving(false), 800);
    } catch (e) {
        setIsSaving(false);
        alert("Failed to save settings to server.");
    }
  };

  const handleAddStep = () => {
    const newId = `step_${Date.now()}`;
    const newStep: BotStep = {
      id: newId,
      title: 'New Question',
      message: '',
      inputType: 'text',
      nextStepId: 'END'
    };
    
    const newSteps = [...settings.steps, newStep];
    setSettings({ ...settings, steps: newSteps });
    setActiveStepId(newId);
  };

  const handleDeleteStep = (id: string) => {
    const newSteps = settings.steps.filter(s => s.id !== id);
    setSettings({ ...settings, steps: newSteps });
    if (activeStepId === id && newSteps.length > 0) {
      setActiveStepId(newSteps[0].id);
    }
  };

  const updateActiveStep = (updates: Partial<BotStep>) => {
    const newSteps = settings.steps.map(s => s.id === activeStepId ? { ...s, ...updates } : s);
    setSettings({ ...settings, steps: newSteps });
  };

  // --- Test Logic ---
  const startTest = () => {
    setTestMessages([]);
    setTestInput('');
    setTestIsAiActive(false);
    
    if (settings.routingStrategy === 'AI_ONLY') {
        setTestIsAiActive(true);
        addTestMessage('system', '👋 [AI Connected]: I am ready to handle the conversation based on your training.');
    } else {
        const firstStep = settings.steps[0];
        if (firstStep) {
          setTestCurrentStepId(firstStep.id);
          addTestMessage('system', firstStep.message, firstStep.inputType === 'option' ? firstStep.options : undefined);
        } else {
          setTestCurrentStepId(null);
          addTestMessage('system', 'No steps configured. Add a step to start.');
        }
    }
    setShowTestModal(true);
  };

  const addTestMessage = (sender: 'user' | 'system', text: string, options?: string[]) => {
    setTestMessages(prev => [...prev, { id: Date.now(), sender, text, options }]);
  };

  const handleTestReply = async (text: string) => {
    if (!text.trim()) return;
    addTestMessage('user', text);
    setTestInput('');
    setIsTestTyping(true);

    // 1. AI MODE ACTIVE
    if (testIsAiActive) {
        try {
            // Call the REAL Gemini service with the CURRENT system instruction (from state, not saved DB)
            const result = await analyzeMessage(text, undefined, settings.systemInstruction);
            setIsTestTyping(false);
            addTestMessage('system', result.suggestedReply);
        } catch (e) {
            setIsTestTyping(false);
            addTestMessage('system', "⚠️ AI Error: Check API Key");
        }
        return;
    }

    // 2. BOT FLOW MODE
    setTimeout(async () => {
        if (!testCurrentStepId) {
            setIsTestTyping(false);
            return;
        }
        
        const currentStep = settings.steps.find(s => s.id === testCurrentStepId);
        if (currentStep) {
            // Move Logic
            const nextId = currentStep.nextStepId;
            
            if (nextId === 'AI_HANDOFF') {
                 setIsTestTyping(false);
                 setTestCurrentStepId(null);
                 setTestIsAiActive(true);
                 
                 // Immediately trigger AI welcome/continuation
                 setIsTestTyping(true);
                 try {
                     const prompt = `User just finished the bot flow. Last input: "${text}". Introduce yourself and ask if they have questions.`;
                     const result = await analyzeMessage(prompt, undefined, settings.systemInstruction);
                     setIsTestTyping(false);
                     addTestMessage('system', result.suggestedReply);
                 } catch (e) {
                     setIsTestTyping(false);
                     addTestMessage('system', "🤖 [System]: Handed off to AI. (AI Reply Failed in Test)");
                 }

            } else if (nextId === 'END') {
                 setIsTestTyping(false);
                 addTestMessage('system', '🏁 [System]: Conversation Flow Ended.');
                 setTestCurrentStepId(null);
            } else {
                 setTestCurrentStepId(nextId || null);
                 const nextStep = settings.steps.find(s => s.id === nextId);
                 if (nextStep) {
                     setIsTestTyping(false);
                     // Simulate template message if present
                     const msg = nextStep.templateName ? `[Template: ${nextStep.templateName}] ${nextStep.message}` : nextStep.message;
                     addTestMessage('system', msg, nextStep.inputType === 'option' ? nextStep.options : undefined);
                 } else {
                     setIsTestTyping(false);
                     addTestMessage('system', '⚠️ [Error]: Next step configuration missing.');
                 }
            }
        }
    }, 600);
  };

  const activeStep = settings.steps.find(s => s.id === activeStepId);

  // Helper for icons
  const getInputIcon = (type: string) => {
      switch(type) {
          case 'option': return <List size={14} />;
          case 'image': return <ImageIcon size={14} />;
          default: return <Type size={14} />;
      }
  };

  return (
    <div className="flex flex-col h-full bg-gray-50 overflow-hidden font-sans">
      
      {/* Top Navigation Bar */}
      <div className="bg-white border-b border-gray-200 px-6 h-16 flex items-center justify-between shrink-0 shadow-sm z-10">
         <div className="flex items-center gap-3">
            <div className="bg-blue-600 text-white p-2 rounded-lg shadow-sm">
                <BrainCircuit size={20} />
            </div>
            <div>
                <h1 className="text-lg font-bold text-gray-900 leading-tight">Bot Studio</h1>
                <p className="text-xs text-gray-400">Design your conversational flow</p>
            </div>
         </div>
         <div className="flex items-center gap-3">
             {isLiveMode && (
                 <div className="flex items-center gap-2 px-3 py-1 bg-red-50 text-red-600 rounded-full border border-red-100 text-xs font-bold animate-pulse">
                     <span className="w-2 h-2 bg-red-500 rounded-full"></span>
                     LIVE MODE
                 </div>
             )}
             <button 
                onClick={handleSave}
                disabled={isSaving}
                className="bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                >
                {isSaving ? 'Saving...' : <><Save size={16} /> Save Changes</>}
             </button>
             <button 
               onClick={startTest}
               className="bg-gray-900 hover:bg-gray-800 text-white px-5 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 shadow-md hover:shadow-lg transform hover:-translate-y-0.5"
             >
                <Play size={16} fill="currentColor" />
                Test Bot
             </button>
         </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* LEFT: Modern Flow Sequence */}
        <div className="w-80 bg-white border-r border-gray-200 flex flex-col z-0">
            <div className="p-5 border-b border-gray-100 bg-gray-50/30">
                <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                    <List size={14} />
                    Sequence Order
                </h2>
            </div>
            
            {loadError && (
                <div className="p-4 bg-red-50 text-red-600 text-xs flex items-center gap-2">
                    <AlertCircle size={14} /> {loadError}
                </div>
            )}

            <div className="flex-1 overflow-y-auto p-4 relative">
                {/* Timeline Line */}
                <div className="absolute left-8 top-6 bottom-0 w-0.5 bg-gray-200" />

                <div className="space-y-6 relative">
                    {settings.steps.map((step, idx) => (
                        <div key={step.id} className="relative pl-10 group">
                            {/* Connector Dot */}
                            <div 
                                className={`absolute left-2.5 top-4 w-3 h-3 rounded-full border-2 z-10 transition-colors ${
                                    activeStepId === step.id ? 'bg-blue-600 border-blue-600' : 'bg-white border-gray-300 group-hover:border-blue-400'
                                }`}
                            />
                            
                            {/* Card */}
                            <div 
                                onClick={() => setActiveStepId(step.id)}
                                className={`
                                    cursor-pointer rounded-xl border p-4 transition-all duration-200
                                    ${activeStepId === step.id 
                                        ? 'bg-white border-blue-500 ring-4 ring-blue-50 shadow-md transform scale-[1.02]' 
                                        : 'bg-white border-gray-200 hover:border-blue-300 hover:shadow-sm'
                                    }
                                `}
                            >
                                <div className="flex items-center justify-between mb-2">
                                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Step {idx + 1}</span>
                                    <button 
                                        onClick={(e) => { e.stopPropagation(); handleDeleteStep(step.id); }} 
                                        className="text-gray-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                                <h4 className={`font-semibold text-sm mb-1 ${activeStepId === step.id ? 'text-blue-700' : 'text-gray-900'}`}>
                                    {step.title}
                                </h4>
                                <p className="text-xs text-gray-500 line-clamp-1 mb-3">
                                    {step.templateName ? `[Template] ${step.templateName}` : step.message}
                                </p>
                                
                                <div className="flex items-center gap-2">
                                    <span className={`text-[10px] px-2 py-1 rounded-md flex items-center gap-1 font-medium ${
                                        activeStepId === step.id ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
                                    }`}>
                                        {getInputIcon(step.inputType)}
                                        {step.inputType.toUpperCase()}
                                    </span>
                                    {step.nextStepId === 'AI_HANDOFF' && (
                                        <span className="text-[10px] px-2 py-1 rounded-md bg-purple-100 text-purple-700 font-bold flex items-center gap-1">
                                            <Sparkles size={10} /> AI HANDOFF
                                        </span>
                                    )}
                                    {step.templateName && (
                                        <span className="text-[10px] px-2 py-1 rounded-md bg-green-100 text-green-700 font-bold flex items-center gap-1">
                                            <FileCode size={10} /> TMPL
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}

                    <div className="relative pl-10 pt-2">
                        <div className="absolute left-3.5 top-5 w-1 h-1 bg-gray-300 rounded-full" />
                        <button 
                            onClick={handleAddStep}
                            className="w-full py-3 border-2 border-dashed border-gray-300 rounded-xl text-gray-400 text-xs font-bold uppercase tracking-wider hover:border-blue-500 hover:text-blue-600 hover:bg-blue-50 transition-all flex items-center justify-center gap-2"
                        >
                            <Plus size={16} />
                            Add Step
                        </button>
                    </div>
                </div>
            </div>
        </div>

        {/* CENTER: Step Editor */}
        <div className="flex-1 overflow-y-auto bg-gray-50/50 p-8">
            {activeStep ? (
            <div className="max-w-3xl mx-auto space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
                {/* Configuration Card */}
                <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
                    <div className="flex items-center gap-4 mb-8 pb-6 border-b border-gray-100">
                        <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-blue-600 text-white rounded-xl flex items-center justify-center shadow-lg shadow-blue-200">
                            <Settings2 size={24} />
                        </div>
                        <div>
                            <h3 className="font-bold text-xl text-gray-900">Step Configuration</h3>
                            <p className="text-sm text-gray-500">Define the bot's behavior for this interaction point.</p>
                        </div>
                    </div>

                    <div className="space-y-6">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <label className="block text-xs font-bold text-gray-700 uppercase mb-2">Internal Title</label>
                                <input 
                                type="text" 
                                value={activeStep.title}
                                onChange={(e) => updateActiveStep({ title: e.target.value })}
                                className="w-full bg-gray-50 border border-gray-200 rounded-lg px-4 py-2.5 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm transition-all"
                                placeholder="e.g. Ask Name"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-gray-700 uppercase mb-2">Expected Input</label>
                                <select 
                                value={activeStep.inputType}
                                onChange={(e) => updateActiveStep({ inputType: e.target.value as any })}
                                className="w-full bg-gray-50 border border-gray-200 rounded-lg px-4 py-2.5 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm cursor-pointer"
                                >
                                <option value="text">Text Message</option>
                                <option value="image">Image Attachment</option>
                                <option value="option">Select Options (Buttons)</option>
                                </select>
                            </div>
                        </div>

                        {/* WhatsApp Template Toggle */}
                        <div className="bg-gray-50 border border-gray-200 rounded-xl p-5">
                            <div className="flex items-center justify-between mb-4">
                                <label className="flex items-center gap-2 text-sm font-bold text-gray-800">
                                    <FileCode size={16} className="text-green-600" />
                                    Use Pre-approved Template
                                </label>
                                <div className="relative inline-block w-10 h-6 align-middle select-none transition duration-200 ease-in">
                                    <input 
                                        type="checkbox" 
                                        name="toggle" 
                                        id="toggle-template" 
                                        className="toggle-checkbox absolute block w-5 h-5 rounded-full bg-white border-4 appearance-none cursor-pointer border-gray-300 checked:right-0 checked:border-green-500 right-4"
                                        checked={!!activeStep.templateName}
                                        onChange={(e) => updateActiveStep({ templateName: e.target.checked ? 'hello_world' : undefined })}
                                    />
                                    <label htmlFor="toggle-template" className={`toggle-label block overflow-hidden h-6 rounded-full cursor-pointer ${activeStep.templateName ? 'bg-green-500' : 'bg-gray-300'}`}></label>
                                </div>
                            </div>

                            {activeStep.templateName !== undefined && (
                                <div className="animate-in fade-in slide-in-from-top-2">
                                    <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Template Name (from Meta)</label>
                                    <input 
                                        type="text" 
                                        value={activeStep.templateName}
                                        onChange={(e) => updateActiveStep({ templateName: e.target.value })}
                                        className="w-full bg-white border border-gray-300 rounded-lg px-4 py-2 text-sm focus:ring-2 focus:ring-green-500 outline-none"
                                        placeholder="e.g. encho_enterprises"
                                    />
                                    <p className="text-[10px] text-gray-400 mt-2">
                                        Must match exactly with a template created in WhatsApp Manager.
                                    </p>
                                </div>
                            )}
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-gray-700 uppercase mb-2 flex justify-between">
                                <span>Bot Message</span>
                                <span className="text-gray-400 font-normal normal-case">
                                    {activeStep.templateName ? 'Description / Fallback Text' : 'What the user sees'}
                                </span>
                            </label>
                            <textarea 
                            value={activeStep.message}
                            onChange={(e) => updateActiveStep({ message: e.target.value })}
                            className="w-full bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm h-32 resize-none leading-relaxed"
                            placeholder="Type the message here..."
                            />
                        </div>

                        {/* Conditional Options Input (Only if NOT using Template) */}
                        {activeStep.inputType === 'option' && !activeStep.templateName && (
                            <div className="bg-blue-50 p-5 rounded-xl border border-blue-100 animate-in fade-in zoom-in-95">
                                <label className="block text-xs font-bold text-blue-800 uppercase mb-2">Button Options</label>
                                <input 
                                type="text"
                                value={activeStep.options?.join(', ') || ''}
                                onChange={(e) => updateActiveStep({ options: e.target.value.split(',').map(s => s.trim()) })}
                                placeholder="e.g. Yes, No, Maybe (Comma separated)"
                                className="w-full bg-white border border-blue-200 rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none" 
                                />
                                <p className="text-[10px] text-blue-600 mt-2">WhatsApp allows up to 3 buttons per message.</p>
                            </div>
                        )}

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-gray-100">
                             <div>
                                <label className="block text-xs font-bold text-gray-700 uppercase mb-2">Save Response To</label>
                                <select 
                                value={activeStep.saveToField || ''}
                                onChange={(e) => updateActiveStep({ saveToField: e.target.value as any })}
                                className="w-full bg-white border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                                >
                                <option value="">Don't Save (Just Logic)</option>
                                <option value="name">Driver Name</option>
                                <option value="vehicleRegistration">Vehicle Number</option>
                                <option value="availability">Availability</option>
                                <option value="document">Document List</option>
                                </select>
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-gray-700 uppercase mb-2">Next Step</label>
                                <div className="relative">
                                    <select 
                                        value={activeStep.nextStepId || 'END'}
                                        onChange={(e) => updateActiveStep({ nextStepId: e.target.value })}
                                        className={`w-full border rounded-lg px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none appearance-none font-medium ${
                                            activeStep.nextStepId === 'AI_HANDOFF' ? 'bg-purple-50 border-purple-200 text-purple-700' : 'bg-white border-gray-300'
                                        }`}
                                    >
                                        {settings.steps.map(s => (
                                        <option key={s.id} value={s.id}>Step: {s.title}</option>
                                        ))}
                                        <option value="AI_HANDOFF">🤖 Handover to Gemini AI</option>
                                        <option value="END">🏁 End Conversation</option>
                                    </select>
                                    <ArrowDown size={14} className="absolute right-4 top-3 text-gray-400 pointer-events-none" />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            ) : (
            <div className="flex flex-col items-center justify-center h-full text-gray-400">
                <div className="w-24 h-24 bg-gray-100 rounded-full flex items-center justify-center mb-6">
                    <GripVertical size={32} className="opacity-20" />
                </div>
                <h3 className="text-lg font-medium text-gray-900">No Step Selected</h3>
                <p className="max-w-xs text-center mt-2">Select a step from the Flow Sequence on the left or create a new one to get started.</p>
                <button 
                    onClick={handleAddStep}
                    className="mt-6 px-6 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
                >
                    Create First Step
                </button>
            </div>
            )}
        </div>
      </div>

      {/* Test Bot Modal */}
      {showTestModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md h-[700px] flex flex-col overflow-hidden relative">
                {/* Modal Header */}
                <div className="bg-gray-900 text-white p-5 flex items-center justify-between shrink-0 shadow-md">
                    <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-full ${testIsAiActive ? 'bg-purple-600' : 'bg-blue-600'}`}>
                            {testIsAiActive ? <Sparkles size={18} /> : <BotIcon size={18} />}
                        </div>
                        <div>
                            <h3 className="font-bold text-sm">{testIsAiActive ? 'Gemini AI Agent' : 'Rule-Based Bot'}</h3>
                            <p className="text-[10px] text-gray-400 flex items-center gap-1">
                                <span className={`w-1.5 h-1.5 rounded-full ${testIsAiActive ? 'bg-purple-400' : 'bg-green-400'} animate-pulse`}></span>
                                Online & Testing
                            </p>
                        </div>
                    </div>
                    <button onClick={() => setShowTestModal(false)} className="hover:bg-white/20 p-2 rounded-full transition-colors">
                        <X size={20} />
                    </button>
                </div>
                
                {/* Chat Area */}
                <div className="flex-1 overflow-y-auto p-5 space-y-6 bg-gray-100">
                    {testMessages.map((msg) => (
                        <div key={msg.id} className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                            {msg.sender === 'system' && (
                                <div className={`w-8 h-8 rounded-full flex items-center justify-center mr-3 mt-1 shrink-0 shadow-sm ${
                                    testIsAiActive ? 'bg-purple-600 text-white' : 'bg-blue-600 text-white'
                                }`}>
                                    {testIsAiActive ? <Sparkles size={14} /> : <BotIcon size={14} />}
                                </div>
                            )}
                            <div className="flex flex-col gap-2 max-w-[80%]">
                                <div className={`px-4 py-3 rounded-2xl shadow-sm text-sm leading-relaxed ${
                                    msg.sender === 'user' 
                                    ? 'bg-gray-900 text-white rounded-tr-none' 
                                    : 'bg-white text-gray-800 rounded-tl-none border border-gray-200'
                                }`}>
                                    {msg.text}
                                </div>
                                {/* Option Buttons */}
                                {msg.options && msg.options.length > 0 && (
                                    <div className="flex flex-wrap gap-2 animate-in slide-in-from-left-2 fade-in duration-300">
                                        {msg.options.map((opt) => (
                                            <button 
                                                key={opt}
                                                onClick={() => handleTestReply(opt)}
                                                className="bg-white border border-blue-200 text-blue-700 text-xs font-bold px-4 py-2 rounded-full hover:bg-blue-50 hover:border-blue-400 transition-all shadow-sm"
                                            >
                                                {opt}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                    {isTestTyping && (
                        <div className="flex justify-start animate-in fade-in">
                             <div className={`w-8 h-8 rounded-full flex items-center justify-center mr-3 mt-1 shrink-0 ${
                                testIsAiActive ? 'bg-purple-600 text-white' : 'bg-blue-600 text-white'
                             }`}>
                                {testIsAiActive ? <Sparkles size={14} /> : <BotIcon size={14} />}
                            </div>
                            <div className="bg-white border border-gray-200 px-4 py-3 rounded-2xl rounded-tl-none shadow-sm flex items-center gap-1.5">
                                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"></span>
                                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce delay-100"></span>
                                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce delay-200"></span>
                            </div>
                        </div>
                    )}
                    <div ref={messagesEndRef} />
                </div>

                {/* Input Area */}
                <div className="p-4 bg-white border-t border-gray-200 shrink-0">
                    <div className="flex items-center gap-2 bg-gray-100 border border-gray-200 rounded-full px-5 py-3 focus-within:ring-2 focus-within:ring-blue-500 focus-within:bg-white transition-all shadow-inner">
                        <input 
                            type="text"
                            value={testInput}
                            onChange={(e) => setTestInput(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleTestReply(testInput)}
                            placeholder={testIsAiActive ? "Ask the AI anything..." : "Type your reply..."}
                            className="flex-1 bg-transparent border-none outline-none text-sm text-gray-800 placeholder:text-gray-400"
                        />
                        <button 
                            onClick={() => handleTestReply(testInput)}
                            disabled={!testInput.trim()}
                            className="text-blue-600 hover:text-blue-700 disabled:opacity-30 transition-colors transform active:scale-95"
                        >
                            <Send size={20} fill="currentColor" />
                        </button>
                    </div>
                    <div className="text-center mt-3">
                         <button onClick={startTest} className="text-[10px] text-gray-400 hover:text-gray-600 font-medium flex items-center justify-center gap-1 mx-auto hover:underline decoration-gray-300 underline-offset-2">
                            <Play size={10} /> Restart Simulation
                         </button>
                    </div>
                </div>
            </div>
        </div>
      )}
    </div>
  );
};