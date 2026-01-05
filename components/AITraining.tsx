import React, { useState, useEffect } from 'react';
import { BotSettings } from '../types';
import { mockBackend } from '../services/mockBackend';
import { liveApiService } from '../services/liveApiService';
import { Save, Sparkles, AlertCircle, Bot } from 'lucide-react';

interface AITrainingProps {
  isLiveMode: boolean;
}

export const AITraining: React.FC<AITrainingProps> = ({ isLiveMode }) => {
  const [settings, setSettings] = useState<BotSettings>(mockBackend.getBotSettings());
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    const loadSettings = async () => {
      if (isLiveMode) {
        try {
          const liveSettings = await liveApiService.getBotSettings();
          setSettings(liveSettings);
        } catch (e) {
          setLoadError("Could not load live settings. Ensure server is running.");
        }
      } else {
        setSettings(mockBackend.getBotSettings());
      }
    };
    loadSettings();
  }, [isLiveMode]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      if (isLiveMode) {
        await liveApiService.saveBotSettings(settings);
      } else {
        mockBackend.updateBotSettings(settings);
      }
      setTimeout(() => setIsSaving(false), 800);
    } catch (e) {
      setIsSaving(false);
      alert("Failed to save settings.");
    }
  };

  return (
    <div className="flex flex-col h-full bg-gray-50 overflow-hidden font-sans">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-8 h-20 flex items-center justify-between shrink-0 shadow-sm z-10">
        <div className="flex items-center gap-4">
          <div className="bg-purple-600 text-white p-2.5 rounded-xl shadow-md shadow-purple-200">
            <Sparkles size={24} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight">AI Persona Trainer</h1>
            <p className="text-sm text-gray-500">Define how the AI recruiter speaks and behaves.</p>
          </div>
        </div>
        <button 
          onClick={handleSave}
          disabled={isSaving}
          className="bg-black hover:bg-gray-800 text-white px-6 py-2.5 rounded-lg text-sm font-bold transition-all flex items-center gap-2 shadow-lg transform hover:-translate-y-0.5 active:translate-y-0"
        >
          {isSaving ? 'Saving...' : <><Save size={18} /> Save Changes</>}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-4xl mx-auto space-y-6">
          
          {loadError && (
            <div className="p-4 bg-red-50 text-red-600 rounded-xl flex items-center gap-3 border border-red-100">
              <AlertCircle size={20} />
              <span className="font-medium">{loadError}</span>
            </div>
          )}

          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden flex flex-col h-[calc(100vh-180px)]">
             <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Bot size={16} className="text-gray-400" />
                    <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">System Instruction Prompt</span>
                </div>
                <span className="text-[10px] bg-purple-100 text-purple-700 px-2 py-1 rounded-md font-bold border border-purple-200">
                   GEMINI 1.5 FLASH
                </span>
             </div>
             
             <div className="flex-1 relative">
                <textarea 
                  value={settings.systemInstruction}
                  onChange={(e) => setSettings({...settings, systemInstruction: e.target.value})}
                  className="w-full h-full p-8 text-sm leading-7 text-gray-700 font-mono resize-none focus:outline-none focus:bg-gray-50/30 transition-colors"
                  placeholder="You are a helpful assistant..."
                  spellCheck={false}
                />
             </div>
             
             <div className="px-6 py-3 bg-gray-50 border-t border-gray-100 text-xs text-gray-400 flex justify-between">
                <span>Markdown formatting supported</span>
                <span>{settings.systemInstruction.length} characters</span>
             </div>
          </div>
        </div>
      </div>
    </div>
  );
};