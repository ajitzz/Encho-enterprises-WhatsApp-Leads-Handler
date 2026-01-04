import React, { useState } from 'react';
import { mockBackend } from '../services/mockBackend';
import { analyzeMessage } from '../services/geminiService';
import { MessageSquare, Upload, Smartphone, Facebook } from 'lucide-react';
import { Notification } from '../types';

interface SimulatorProps {
  onNotify: (n: Omit<Notification, 'id'>) => void;
}

export const Simulator: React.FC<SimulatorProps> = ({ onNotify }) => {
  const [mode, setMode] = useState<'whatsapp' | 'ad'>('whatsapp');
  
  // WhatsApp State
  const [phone, setPhone] = useState('+91 98765 43210');
  const [message, setMessage] = useState('');
  const [hasImage, setHasImage] = useState(false);
  
  // Ad State
  const [adName, setAdName] = useState('Rahul Verma');
  const [adPhone, setAdPhone] = useState('+91 91234 56789');

  const [isProcessing, setIsProcessing] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  const handleSimulateMessage = async () => {
    if (!phone || (!message && !hasImage)) return;
    
    setIsProcessing(true);
    
    try {
      const imageUrl = hasImage ? `https://picsum.photos/400/300?random=${Date.now()}` : undefined;
      const text = message || (hasImage ? "Here is the photo" : "");

      // 1. Send Message to Backend (Bot Engine)
      const result = mockBackend.processIncomingMessage(phone, text, imageUrl);
      const { driver, actionNeeded } = result;
      
      onNotify({
        type: 'info',
        title: 'New Message',
        message: `Message received from ${driver.name}`
      });

      // 2. If Bot didn't handle it, or Bot requested AI Handoff
      if (actionNeeded === 'AI_REPLY') {
          // Get current system instruction from settings
          const settings = mockBackend.getBotSettings();
          
          const aiResult = await analyzeMessage(text, imageUrl, settings.systemInstruction);
          
          if (aiResult.extractedData) {
             mockBackend.updateDriverDetails(driver.id, {
                vehicleRegistration: aiResult.extractedData.vehicleRegistration || driver.vehicleRegistration,
                availability: (aiResult.extractedData.availability as any) || driver.availability,
                qualificationChecks: {
                  ...driver.qualificationChecks,
                  hasValidLicense: aiResult.extractedData.isLicenseValid || driver.qualificationChecks.hasValidLicense
                }
             });
          }

          if (aiResult.recommendedStatus && aiResult.recommendedStatus !== driver.status) {
             mockBackend.updateDriverStatus(driver.id, aiResult.recommendedStatus);
             if (aiResult.recommendedStatus === 'Flagged') {
                onNotify({
                  type: 'warning',
                  title: 'AI Alert: Review Needed',
                  message: `AI flagged ${driver.name} for manual review.`
                });
             }
          }
          
          // Send AI Reply
          setTimeout(() => {
            mockBackend.addMessage(driver.id, {
              id: Date.now().toString(),
              sender: 'system',
              text: `[AI]: ${aiResult.suggestedReply}`,
              timestamp: Date.now(),
              type: 'text'
            });
          }, 1000);
      }

      setMessage('');
      setHasImage(false);

    } catch (e) {
      console.error(e);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSimulateAdLead = async () => {
    if (!adName || !adPhone) return;
    setIsProcessing(true);

    try {
        const driver = mockBackend.createAdLead(adName, adPhone);
        
        onNotify({
            type: 'success',
            title: 'New Meta Ad Lead',
            message: `${driver.name} captured from Facebook Ad. Bot sequence started.`
        });

        // Reset
        setAdName('Rahul Verma');
        setAdPhone('+91 ' + Math.floor(Math.random() * 9000000000));
        
    } catch(e) {
        console.error(e);
    } finally {
        setIsProcessing(false);
    }
  };

  if (!isOpen) {
    return (
      <button 
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 bg-blue-600 text-white p-4 rounded-full shadow-xl hover:bg-blue-700 transition-all z-40 animate-bounce"
        title="Open Simulator"
      >
        <Smartphone size={24} />
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 w-80 bg-white rounded-xl shadow-2xl border border-gray-200 z-40 overflow-hidden font-sans">
      <div className="bg-gradient-to-r from-green-600 to-green-500 p-4 flex justify-between items-center text-white">
        <h3 className="font-bold flex items-center gap-2">
          <Smartphone size={18} /> 
          Integration Simulator
        </h3>
        <button onClick={() => setIsOpen(false)} className="hover:bg-white/20 p-1 rounded">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200">
        <button 
            onClick={() => setMode('whatsapp')}
            className={`flex-1 py-3 text-xs font-medium ${mode === 'whatsapp' ? 'bg-white text-green-600 border-b-2 border-green-600' : 'bg-gray-50 text-gray-500'}`}
        >
            WhatsApp Message
        </button>
        <button 
            onClick={() => setMode('ad')}
            className={`flex-1 py-3 text-xs font-medium flex items-center justify-center gap-1 ${mode === 'ad' ? 'bg-white text-blue-600 border-b-2 border-blue-600' : 'bg-gray-50 text-gray-500'}`}
        >
            <Facebook size={12} />
            Meta Ad Lead
        </button>
      </div>
      
      {mode === 'whatsapp' ? (
      <div className="p-4 space-y-4">
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">Sender Phone</label>
          <input 
            type="text" 
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-green-500 outline-none"
          />
        </div>
        
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">Message Body</label>
          <textarea 
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-green-500 outline-none h-20 resize-none"
            placeholder="Type message..."
          />
        </div>
        
        <div className="flex items-center gap-3">
          <button 
            onClick={() => setHasImage(!hasImage)}
            className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg border text-sm transition-colors ${
              hasImage ? 'bg-green-50 border-green-500 text-green-700' : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
            }`}
          >
            <Upload size={16} />
            {hasImage ? 'Image Attached' : 'Attach Image'}
          </button>
        </div>

        <button 
          onClick={handleSimulateMessage}
          disabled={isProcessing}
          className="w-full bg-green-600 hover:bg-green-700 text-white font-medium py-2.5 rounded-lg shadow-sm transition-all flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed"
        >
          {isProcessing ? 'Simulating...' : (
            <>
              <MessageSquare size={18} />
              Receive Webhook
            </>
          )}
        </button>
      </div>
      ) : (
      <div className="p-4 space-y-4">
          <div className="bg-blue-50 border border-blue-100 p-3 rounded-lg text-xs text-blue-800 mb-2">
              <p>Simulates a user filling an "Instant Form" on Facebook/Instagram. The <strong>Bot</strong> will start automatically.</p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">Lead Name</label>
            <input 
                type="text" 
                value={adName}
                onChange={(e) => setAdName(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">Lead Phone</label>
            <input 
                type="text" 
                value={adPhone}
                onChange={(e) => setAdPhone(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
          <button 
            onClick={handleSimulateAdLead}
            disabled={isProcessing}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg shadow-sm transition-all flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed"
            >
            {isProcessing ? 'Processing Lead...' : (
                <>
                <Facebook size={18} />
                Capture Ad Lead
                </>
            )}
        </button>
      </div>
      )}
      
      <div className="bg-gray-50 p-3 text-[10px] text-gray-400 text-center border-t border-gray-100">
        Simulates events from Meta Graph API
      </div>
    </div>
  );
};