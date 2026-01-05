import React, { useState, useEffect, useRef } from 'react';
import { BotSettings, BotStep } from '../types';
import { mockBackend } from '../services/mockBackend';
import { liveApiService } from '../services/liveApiService';
import { Save, Plus, Trash2, BrainCircuit, MessageSquare, Settings2, Sparkles, AlertCircle, Play, X, Send, User, Bot as BotIcon } from 'lucide-react';

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
  }, [testMessages, showTestModal]);

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
    const firstStep = settings.steps[0];
    if (firstStep) {
      setTestCurrentStepId(firstStep.id);
      addTestMessage('system', firstStep.message, firstStep.inputType === 'option' ? firstStep.options : undefined);
    } else {
      setTestCurrentStepId(null);
      addTestMessage('system', 'No steps configured. Add a step to start.');
    }
    setShowTestModal(true);
  };

  const addTestMessage = (sender: 'user' | 'system', text: string, options?: string[]) => {
    setTestMessages(prev => [...prev, { id: Date.now(), sender, text, options }]);
  };

  const handleTestReply = (text: string) => {
    if (!text.trim()) return;
    addTestMessage('user', text);
    setTestInput('');

    // Simulate Bot Response Delay
    setTimeout(() => {
        // AI ONLY Strategy Bypass
        if (settings.routingStrategy === 'AI_ONLY') {
            addTestMessage('system', `[AI Simulation]: I received "${text}". (AI would handle this entire conversation).`);
            return;
        }

        if (!testCurrentStepId) return;
        
        const currentStep = settings.steps.find(s => s.id === testCurrentStepId);
        if (currentStep) {
            // Simulate saving data (visual only)
            if (currentStep.saveToField) {
                console.log(`[Test] Saved "${text}" to ${currentStep.saveToField}`);
            }

            const nextId = currentStep.nextStepId;
            
            if (nextId === 'AI_HANDOFF') {
                 addTestMessage('system', '🔄 [System]: Handing off to AI Agent...');
                 setTimeout(() => {
                     addTestMessage('system', `[AI Persona]: Thanks for providing that info! I can now help answer any other questions you have.`);
                 }, 800);
                 setTestCurrentStepId(null);
            } else if (nextId === 'END') {
                 addTestMessage('system', '🏁 [System]: Conversation Flow Ended.');
                 setTestCurrentStepId(null);
            } else {
                 setTestCurrentStepId(nextId || null);
                 const nextStep = settings.steps.find(s => s.id === nextId);
                 if (nextStep) {
                     addTestMessage('system', nextStep.message, nextStep.inputType === 'option' ? nextStep.options : undefined);
                 } else {
                     addTestMessage('system', '⚠️ [Error]: Next step configuration missing.');
                 }
            }
        }
    }, 600);
  };

  const activeStep = settings.steps.find(s => s.id === activeStepId);

  return (
    <div className="flex flex-col h-full bg-gray-50 overflow-hidden">
      
      {/* Top Navigation Bar */}
      <div className="bg-white border-b border-gray-200 px-6 h-16 flex items-center justify-between shrink-0 shadow-sm z-10">
         <div className="flex items-center gap-3">
            <div className="bg-blue-100 text-blue-600 p-2 rounded-lg">
                <BrainCircuit size={20} />
            </div>
            <div>
                <h1 className="text-lg font-bold text-gray-900 leading-tight">Bot Studio</h1>
                <p className="text-xs text-gray-400">Design your conversational flow</p>
            </div>
         </div>
         <button 
           onClick={startTest}
           className="bg-green-600 hover:bg-green-700 text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-all flex items-center gap-2 shadow-md hover:shadow-lg transform hover:-translate-y-0.5"
         >
            <Play size={16} fill="currentColor" />
            Test Bot
         </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* LEFT: Sidebar / Flow List */}
        <div className="w-80 bg-white border-r border-gray-200 flex flex-col">
            <div className="p-4 border-b border-gray-100 bg-gray-50/50">
            <div className="flex items-center justify-between mb-2">
                <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Flow Sequence</h2>
                {isLiveMode && <span className="text-[10px] bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-bold animate-pulse">LIVE MODE</span>}
            </div>
            </div>
            
            {loadError && (
                <div className="p-4 bg-red-50 text-red-600 text-xs flex items-center gap-2">
                    <AlertCircle size={14} /> {loadError}
                </div>
            )}

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {settings.steps.map((step, idx) => (
                <div 
                key={step.id}
                onClick={() => setActiveStepId(step.id)}
                className={`relative p-4 rounded-xl border transition-all cursor-pointer group ${
                    activeStepId === step.id 
                    ? 'bg-blue-50 border-blue-500 shadow-sm' 
                    : 'bg-white border-gray-200 hover:border-blue-300'
                }`}
                >
                <div className="flex items-center justify-between mb-2">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${activeStepId === step.id ? 'bg-blue-200 text-blue-800' : 'bg-gray-100 text-gray-500'}`}>
                        STEP {idx + 1}
                    </span>
                    <button onClick={(e) => { e.stopPropagation(); handleDeleteStep(step.id); }} className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Trash2 size={14} />
                    </button>
                </div>
                <h4 className="font-semibold text-gray-900 text-sm mb-1 line-clamp-1">{step.title}</h4>
                <p className="text-xs text-gray-500 line-clamp-2">{step.message}</p>
                
                {idx < settings.steps.length - 1 && (
                    <div className="absolute left-1/2 -bottom-6 w-0.5 h-3 bg-gray-300 z-10" />
                )}
                </div>
            ))}

            <button 
                onClick={handleAddStep}
                className="w-full py-3 border-2 border-dashed border-gray-300 rounded-xl text-gray-400 text-sm font-medium hover:border-blue-500 hover:text-blue-600 transition-colors flex items-center justify-center gap-2 mt-2"
            >
                <Plus size={16} />
                Add Step
            </button>
            </div>
        </div>

        {/* CENTER: Step Editor */}
        <div className="flex-1 overflow-y-auto bg-gray-50 p-8">
            {activeStep ? (
            <div className="max-w-2xl mx-auto space-y-6">
                {/* Preview Card */}
                <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
                    <div className="flex items-center gap-3 mb-6 pb-4 border-b border-gray-100">
                    <div className="p-2 bg-blue-100 text-blue-600 rounded-lg">
                        <MessageSquare size={20} />
                    </div>
                    <div>
                        <h3 className="font-bold text-lg text-gray-900">Configure Step</h3>
                        <p className="text-xs text-gray-500">Edit how the bot interacts at this stage.</p>
                    </div>
                    </div>

                    <div className="space-y-5">
                    <div>
                        <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Step Title (Internal)</label>
                        <input 
                        type="text" 
                        value={activeStep.title}
                        onChange={(e) => updateActiveStep({ title: e.target.value })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Bot Message</label>
                        <textarea 
                        value={activeStep.message}
                        onChange={(e) => updateActiveStep({ message: e.target.value })}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 outline-none text-sm h-24 resize-none"
                        placeholder="What should the bot say?"
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Input Type</label>
                            <select 
                            value={activeStep.inputType}
                            onChange={(e) => updateActiveStep({ inputType: e.target.value as any })}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                            >
                            <option value="text">Text Reply</option>
                            <option value="image">Image/Document</option>
                            <option value="option">Buttons (Options)</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Save Data To</label>
                            <select 
                            value={activeStep.saveToField || ''}
                            onChange={(e) => updateActiveStep({ saveToField: e.target.value as any })}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                            >
                            <option value="">Don't Save</option>
                            <option value="name">Driver Name</option>
                            <option value="vehicleRegistration">Vehicle Number</option>
                            <option value="availability">Availability</option>
                            <option value="document">Document List</option>
                            </select>
                        </div>
                    </div>

                    {activeStep.inputType === 'option' && (
                        <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                            <label className="block text-xs font-bold text-gray-700 uppercase mb-2">Button Options (Comma Separated)</label>
                            <input 
                            type="text"
                            value={activeStep.options?.join(', ') || ''}
                            onChange={(e) => updateActiveStep({ options: e.target.value.split(',').map(s => s.trim()) })}
                            placeholder="Yes, No, Maybe"
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" 
                            />
                        </div>
                    )}

                    <div className="pt-4 border-t border-gray-100">
                        <label className="block text-xs font-bold text-gray-700 uppercase mb-1">After Reply, Go To:</label>
                        <select 
                            value={activeStep.nextStepId || 'END'}
                            onChange={(e) => updateActiveStep({ nextStepId: e.target.value })}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-blue-50 text-blue-900 font-medium"
                        >
                            {settings.steps.map(s => (
                            <option key={s.id} value={s.id}>Step: {s.title}</option>
                            ))}
                            <option value="AI_HANDOFF">🤖 Handover to Gemini AI</option>
                            <option value="END">🏁 End Conversation</option>
                        </select>
                    </div>
                    </div>
                </div>
            </div>
            ) : (
            <div className="flex flex-col items-center justify-center h-full text-gray-400">
                <BrainCircuit size={48} className="mb-4 opacity-20" />
                <p>Select a step to configure.</p>
            </div>
            )}
        </div>

        {/* RIGHT: Global Settings & AI Training */}
        <div className="w-80 bg-white border-l border-gray-200 flex flex-col overflow-y-auto shadow-xl z-20">
            <div className="p-4 bg-gray-900 text-white flex items-center justify-between sticky top-0 z-10">
                <h3 className="font-bold flex items-center gap-2">
                <Settings2 size={16} /> Settings
                </h3>
                <button 
                onClick={handleSave}
                disabled={isSaving}
                className="bg-blue-600 hover:bg-blue-500 text-white text-xs px-3 py-1.5 rounded-md font-medium transition-colors flex items-center gap-1"
                >
                {isSaving ? 'Saving...' : <><Save size={14} /> Save Changes</>}
                </button>
            </div>

            <div className="p-6 space-y-8">
                <section>
                <h4 className="text-sm font-bold text-gray-900 mb-3">Routing Strategy</h4>
                <div className="space-y-3">
                    <label className="flex items-start gap-3 cursor-pointer group">
                        <div className="mt-1">
                            <input 
                                type="radio" 
                                name="strategy" 
                                checked={settings.routingStrategy === 'HYBRID_BOT_FIRST'}
                                onChange={() => setSettings({...settings, routingStrategy: 'HYBRID_BOT_FIRST'})}
                                className="cursor-pointer"
                            />
                        </div>
                        <div>
                            <span className="block text-sm font-medium text-gray-900 group-hover:text-blue-600 transition-colors">Bot First, Then AI</span>
                            <span className="block text-xs text-gray-500 mt-1">Collect details via rigid steps, then let AI answer questions.</span>
                        </div>
                    </label>
                    <label className="flex items-start gap-3 cursor-pointer group">
                        <div className="mt-1">
                            <input 
                                type="radio" 
                                name="strategy" 
                                checked={settings.routingStrategy === 'AI_ONLY'}
                                onChange={() => setSettings({...settings, routingStrategy: 'AI_ONLY'})}
                                className="cursor-pointer"
                            />
                        </div>
                        <div>
                            <span className="block text-sm font-medium text-gray-900 group-hover:text-blue-600 transition-colors">AI Only (Gemini)</span>
                            <span className="block text-xs text-gray-500 mt-1">Gemini handles the entire conversation dynamically.</span>
                        </div>
                    </label>
                </div>
                </section>

                <section>
                <h4 className="text-sm font-bold text-gray-900 mb-3 flex items-center gap-2">
                    <Sparkles size={14} className="text-purple-600" />
                    AI Persona & Training
                </h4>
                <p className="text-xs text-gray-500 mb-3">
                    Instruct Gemini on how to behave, what tone to use, and how to persuade leads.
                </p>
                <textarea 
                    value={settings.systemInstruction}
                    onChange={(e) => setSettings({...settings, systemInstruction: e.target.value})}
                    className="w-full h-64 border border-gray-300 rounded-lg p-3 text-xs leading-relaxed focus:ring-2 focus:ring-purple-500 outline-none resize-none"
                    placeholder="You are an expert recruiter..."
                />
                </section>
            </div>
        </div>
      </div>

      {/* Test Bot Modal */}
      {showTestModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md h-[600px] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                {/* Modal Header */}
                <div className="bg-gray-900 text-white p-4 flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-2">
                        <div className="bg-green-500 p-1.5 rounded-full">
                            <BotIcon size={16} fill="white" />
                        </div>
                        <div>
                            <h3 className="font-bold text-sm">Bot Simulator</h3>
                            <p className="text-[10px] text-gray-400">Testing current configuration</p>
                        </div>
                    </div>
                    <button onClick={() => setShowTestModal(false)} className="hover:bg-white/20 p-1 rounded-full transition-colors">
                        <X size={20} />
                    </button>
                </div>
                
                {/* Chat Area */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-100">
                    {testMessages.map((msg) => (
                        <div key={msg.id} className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                            {msg.sender === 'system' && (
                                <div className="w-6 h-6 rounded-full bg-black text-white flex items-center justify-center mr-2 mt-1 shrink-0">
                                    <BotIcon size={12} />
                                </div>
                            )}
                            <div className="flex flex-col gap-2 max-w-[80%]">
                                <div className={`px-4 py-2.5 rounded-2xl shadow-sm text-sm ${
                                    msg.sender === 'user' 
                                    ? 'bg-green-600 text-white rounded-tr-none' 
                                    : 'bg-white text-gray-800 rounded-tl-none border border-gray-200'
                                }`}>
                                    {msg.text}
                                </div>
                                {/* Option Buttons */}
                                {msg.options && msg.options.length > 0 && (
                                    <div className="flex flex-wrap gap-2">
                                        {msg.options.map((opt) => (
                                            <button 
                                                key={opt}
                                                onClick={() => handleTestReply(opt)}
                                                className="bg-white border border-green-600 text-green-700 text-xs font-medium px-3 py-1.5 rounded-full hover:bg-green-50 transition-colors shadow-sm"
                                            >
                                                {opt}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                    <div ref={messagesEndRef} />
                </div>

                {/* Input Area */}
                <div className="p-3 bg-white border-t border-gray-200 shrink-0">
                    <div className="flex items-center gap-2 bg-gray-50 border border-gray-300 rounded-full px-4 py-2 focus-within:ring-2 focus-within:ring-green-500 focus-within:border-green-500 transition-all">
                        <input 
                            type="text"
                            value={testInput}
                            onChange={(e) => setTestInput(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleTestReply(testInput)}
                            placeholder="Type a message..."
                            className="flex-1 bg-transparent border-none outline-none text-sm"
                        />
                        <button 
                            onClick={() => handleTestReply(testInput)}
                            disabled={!testInput.trim()}
                            className="text-green-600 hover:text-green-700 disabled:opacity-50 transition-colors"
                        >
                            <Send size={18} />
                        </button>
                    </div>
                    <div className="text-center mt-2">
                         <button onClick={startTest} className="text-[10px] text-gray-400 hover:text-gray-600 underline">
                            Restart Simulation
                         </button>
                    </div>
                </div>
            </div>
        </div>
      )}
    </div>
  );
};