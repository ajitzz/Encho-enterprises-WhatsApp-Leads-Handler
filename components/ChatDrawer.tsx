
import React, { useState, useEffect, useRef } from 'react';
import { Driver, Message, LeadStatus, OnboardingStep } from '../types';
import { 
  X, Send, Image as ImageIcon, Video, CheckCircle, UserX, Car, Clock, 
  ShieldCheck, ChevronRight, Facebook, Globe, Headset, MicOff, Phone, 
  FileText, Sparkles, MapPin, ExternalLink, LayoutTemplate
} from 'lucide-react';
import { liveApiService } from '../services/liveApiService';

interface ChatDrawerProps {
  driver: Driver | null;
  onClose: () => void;
  onSendMessage: (text: string) => void;
  onUpdateDriver: (id: string, updates: Partial<Driver>) => void;
}

export const ChatDrawer: React.FC<ChatDrawerProps> = ({ driver, onClose, onSendMessage, onUpdateDriver }) => {
  const [replyText, setReplyText] = useState('');
  const [localNotes, setLocalNotes] = useState('');
  const [isTemplateMode, setIsTemplateMode] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const messages = driver && Array.isArray(driver.messages) ? driver.messages : [];
  const documents = driver && Array.isArray(driver.documents) ? driver.documents : [];

  useEffect(() => {
    if (messagesEndRef.current) messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (driver) setLocalNotes(driver.notes || '');
  }, [driver]);

  if (!driver) return null;

  const handleSend = async () => {
    if (!replyText.trim()) return;
    
    if (isTemplateMode && templateName) {
        // Direct Send via API Service for Template (bypassing parent handler if it doesn't support tempalte arg)
        // Since we need to pass templateName, we should assume onSendMessage can handle it or we call API directly.
        // For consistency with app architecture, we'll assume we can call liveApiService if parent is mock or doesn't support.
        try {
            await liveApiService.sendMessage(driver.id, replyText, { templateName });
            // Add Optimistic Message
            onUpdateDriver(driver.id, { 
                lastMessage: `[Template: ${templateName}]`, 
                lastMessageTime: Date.now() 
            });
        } catch(e) {
            alert("Failed to send template");
        }
    } else {
        onSendMessage(replyText);
    }
    
    setReplyText('');
    setTemplateName('');
    setIsTemplateMode(false);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleUpdateDetails = (updates: Partial<Driver>) => {
    onUpdateDriver(driver.id, updates);
  };

  const handleSaveNotes = () => {
      onUpdateDriver(driver.id, { notes: localNotes });
  };
  
  const toggleHumanMode = () => {
      const newState = !driver.isHumanMode;
      onUpdateDriver(driver.id, { isHumanMode: newState });
      if (newState) onSendMessage("Now our executive on the line to connect");
  };

  const handleVoiceCall = () => {
      onSendMessage("📞 Uber Fleet: Incoming Voice Call Request. Please click here to join: https://meet.google.com/call-voice-mock");
      alert("Voice Call Request Sent to Driver's WhatsApp");
  };

  const handleVideoCall = () => {
      onSendMessage("📹 Uber Fleet: Incoming Video Call Request. Please click here to join: https://meet.google.com/call-video-mock");
      alert("Video Call Request Sent to Driver's WhatsApp");
  };

  const steps = [
    { label: 'Welcome', done: true },
    { label: 'Documents', done: documents.length > 0 },
    { label: 'Vehicle', done: !!driver.vehicleRegistration },
    { label: 'Availability', done: !!driver.availability },
    { label: 'Qualified', done: driver.status === LeadStatus.QUALIFIED }
  ];

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm transition-opacity" onClick={onClose} />
      
      <div className="absolute inset-y-0 right-0 flex max-w-full pl-10 pointer-events-none">
        <div className="pointer-events-auto w-screen max-w-4xl bg-white shadow-2xl flex flex-col h-full">
          
          {/* Header */}
          <div className="bg-black text-white px-6 py-4 flex items-center justify-between shadow-md z-10">
            <div className="flex items-center gap-4">
               <div className="h-10 w-10 bg-gray-800 rounded-full flex items-center justify-center text-lg font-bold">
                 {driver.name.charAt(0)}
               </div>
               <div>
                 <div className="flex items-center gap-2">
                    <h2 className="text-xl font-semibold">{driver.name}</h2>
                    {driver.source === 'Meta Ad' && <span className="bg-blue-600 text-[10px] px-2 py-0.5 rounded-full flex items-center gap-1 font-medium"><Facebook size={10} /> Meta Ad</span>}
                    {driver.source === 'Organic' && <span className="bg-gray-700 text-gray-300 text-[10px] px-2 py-0.5 rounded-full flex items-center gap-1 font-medium"><Globe size={10} /> Organic</span>}
                 </div>
                 <p className="text-gray-400 text-sm font-mono">{driver.phoneNumber}</p>
               </div>
            </div>
            
            <div className="flex items-center gap-4">
               <div className="flex items-center gap-1 bg-gray-800 rounded-lg p-1 border border-gray-700 mr-2">
                   <button onClick={handleVoiceCall} className="p-2 text-gray-300 hover:text-white hover:bg-gray-700 rounded transition-colors" title="Voice Call"><Phone size={18} /></button>
                   <button onClick={handleVideoCall} className="p-2 text-gray-300 hover:text-white hover:bg-gray-700 rounded transition-colors" title="Video Call"><Video size={18} /></button>
               </div>

               <div className="flex items-center gap-2 bg-gray-900 rounded-lg p-1 border border-gray-800">
                    <button onClick={toggleHumanMode} className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-bold transition-all ${driver.isHumanMode ? 'bg-amber-500 text-black' : 'text-gray-400 hover:text-white'}`} title={driver.isHumanMode ? 'Bot is Stopped' : 'Bot is Active'}>
                        {driver.isHumanMode ? <Headset size={14} /> : <MicOff size={14} />}
                        {driver.isHumanMode ? 'Human Agent Mode' : 'Automation Active'}
                    </button>
               </div>

               <select className="bg-gray-800 text-white text-sm border-none rounded-md px-3 py-1.5 cursor-pointer outline-none focus:ring-2 focus:ring-blue-500" value={driver.status} onChange={(e) => onUpdateDriver(driver.id, { status: e.target.value as LeadStatus })}>
                  {Object.values(LeadStatus).map(s => (<option key={s} value={s}>{s}</option>))}
               </select>
              <button onClick={onClose} className="p-2 hover:bg-gray-800 rounded-full transition-colors"><X size={20} /></button>
            </div>
          </div>

          <div className="flex-1 flex overflow-hidden">
            {/* Left: Chat History */}
            <div className="flex-1 flex flex-col border-r border-gray-200 min-w-[400px] relative">
              {driver.isHumanMode && (
                  <div className="absolute top-0 left-0 right-0 bg-amber-50 border-b border-amber-200 p-2 z-10 flex items-center justify-center gap-2 text-xs font-bold text-amber-800 shadow-sm">
                      <Headset size={14} /> Automation Paused. You are in manual control.
                  </div>
              )}

              <div className={`flex-1 overflow-y-auto p-4 bg-gray-50 space-y-4 ${driver.isHumanMode ? 'pt-10' : ''}`}>
                {messages.length > 0 ? (
                    messages.map((msg) => (
                    <div key={msg.id} className={`flex ${msg.sender === 'driver' ? 'justify-start' : 'justify-end'}`}>
                        <div className={`max-w-[80%] rounded-2xl shadow-sm overflow-hidden ${msg.sender === 'driver' ? 'bg-white text-gray-900 rounded-tl-none border border-gray-200' : 'bg-blue-600 text-white rounded-tr-none'}`}>
                            
                            {/* RICH CARD HEADER IMAGE */}
                            {(msg.headerImageUrl || msg.imageUrl) && (
                                <div className="w-full aspect-video overflow-hidden">
                                    <img src={msg.headerImageUrl || msg.imageUrl} alt="Header" className="w-full h-full object-cover" />
                                </div>
                            )}

                            {/* MESSAGE BODY */}
                            <div className="px-4 py-3">
                                {msg.templateName && (
                                    <div className="text-[10px] uppercase font-bold opacity-50 mb-1 flex items-center gap-1">
                                        <LayoutTemplate size={10} /> Template: {msg.templateName}
                                    </div>
                                )}
                                {msg.text && <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.text}</p>}
                                {msg.footerText && <p className={`text-[10px] mt-2 pt-2 border-t opacity-70 ${msg.sender === 'driver' ? 'border-gray-100' : 'border-blue-500'}`}>{msg.footerText}</p>}
                                <div className={`text-[10px] mt-1 text-right opacity-60`}>
                                    {new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                                </div>
                            </div>

                            {/* RICH BUTTONS */}
                            {msg.buttons && msg.buttons.length > 0 && (
                                <div className="border-t border-white/20 divide-y divide-white/20 bg-black/5">
                                    {msg.buttons.map((btn, i) => (
                                        <button key={i} className="w-full py-2.5 text-sm font-semibold flex items-center justify-center gap-2 hover:bg-black/10 transition-colors">
                                            {btn.type === 'url' && <ExternalLink size={14} />}
                                            {btn.type === 'phone' && <Phone size={14} />}
                                            {btn.type === 'location' && <MapPin size={14} />}
                                            {btn.title}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                    ))
                ) : (
                    <div className="h-full flex items-center justify-center text-gray-400 text-sm">No messages yet</div>
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className="p-4 bg-white border-t border-gray-200">
                {isTemplateMode && (
                    <div className="mb-2 bg-purple-50 p-2 rounded-lg border border-purple-100 flex items-center gap-2">
                        <LayoutTemplate size={16} className="text-purple-600" />
                        <input 
                            value={templateName}
                            onChange={(e) => setTemplateName(e.target.value)}
                            placeholder="Template Name (e.g. welcome_v2)"
                            className="flex-1 bg-white border border-gray-200 rounded px-2 py-1 text-xs outline-none"
                            autoFocus
                        />
                        <button onClick={() => setIsTemplateMode(false)} className="text-gray-400 hover:text-gray-600"><X size={14} /></button>
                    </div>
                )}
                <div className="flex gap-3">
                  <button 
                    onClick={() => setIsTemplateMode(!isTemplateMode)}
                    className={`p-3 rounded-xl transition-all ${isTemplateMode ? 'bg-purple-100 text-purple-600' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                    title="Send Template"
                  >
                      <LayoutTemplate size={20} />
                  </button>
                  <textarea value={replyText} onChange={(e) => setReplyText(e.target.value)} onKeyDown={handleKeyPress} placeholder={isTemplateMode ? "Body Parameter (e.g. User Name)..." : "Type a message..."} className="flex-1 resize-none border border-gray-300 rounded-xl p-3 focus:outline-none focus:ring-2 focus:ring-blue-500 h-20" />
                  <button onClick={handleSend} disabled={!replyText.trim() && !templateName} className="self-end bg-black text-white p-3 rounded-xl hover:bg-gray-800 disabled:opacity-50 transition-all"><Send size={20} /></button>
                </div>
              </div>
            </div>

            {/* Right: Driver Profile */}
            <div className="w-[400px] bg-white flex flex-col overflow-y-auto border-l border-gray-200">
              <div className="p-6 border-b border-gray-100 bg-gray-50/50">
                <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Onboarding Progress</h3>
                <div className="flex items-center justify-between relative">
                  <div className="absolute left-0 right-0 top-1/2 h-0.5 bg-gray-200 -z-10" />
                  {steps.map((step, idx) => (
                     <div key={idx} className={`flex flex-col items-center gap-1 bg-white px-1`}>
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold border-2 transition-colors ${step.done ? 'bg-green-500 border-green-500 text-white' : 'bg-white border-gray-300 text-gray-400'}`}>
                          {step.done ? <CheckCircle size={12} /> : idx + 1}
                        </div>
                        <span className="text-[10px] text-gray-500 font-medium">{step.label}</span>
                     </div>
                  ))}
                </div>
              </div>

              <div className="p-6 space-y-8">
                <section>
                    <h3 className="font-semibold text-gray-900 mb-2 flex items-center gap-2"><FileText size={18} className="text-purple-600" /> Smart Notes <Sparkles size={12} className="text-purple-400 animate-pulse" /></h3>
                    <div className="relative group">
                        <textarea value={localNotes} onChange={(e) => setLocalNotes(e.target.value)} onBlur={handleSaveNotes} className="w-full h-32 p-3 text-sm bg-yellow-50/50 border border-yellow-200 rounded-lg focus:ring-2 focus:ring-yellow-400 focus:border-yellow-400 outline-none resize-none" placeholder="AI will auto-fill details here..." />
                    </div>
                </section>

                <section>
                   <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2"><ShieldCheck size={18} className="text-blue-600" /> Qualification Criteria</h3>
                   <div className="space-y-3">
                      <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-100">
                        <span className="text-sm text-gray-600">Valid Driving License</span>
                        <button onClick={() => handleUpdateDetails({ qualificationChecks: { ...driver.qualificationChecks, hasValidLicense: !driver.qualificationChecks?.hasValidLicense } })} className={`p-1 rounded-full ${driver.qualificationChecks?.hasValidLicense ? 'text-green-500 bg-green-100' : 'text-gray-300 bg-gray-200'}`}><CheckCircle size={20} /></button>
                      </div>
                      <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-100">
                        <span className="text-sm text-gray-600">Local Availability</span>
                        <button onClick={() => handleUpdateDetails({ qualificationChecks: { ...driver.qualificationChecks, isLocallyAvailable: !driver.qualificationChecks?.isLocallyAvailable } })} className={`p-1 rounded-full ${driver.qualificationChecks?.isLocallyAvailable ? 'text-green-500 bg-green-100' : 'text-gray-300 bg-gray-200'}`}><CheckCircle size={20} /></button>
                      </div>
                   </div>
                </section>

                <div className="pt-4 border-t border-gray-100">
                  <button onClick={() => { if (driver.qualificationChecks?.hasValidLicense) onUpdateDriver(driver.id, { status: LeadStatus.QUALIFIED }); else alert("Cannot qualify driver without a valid license check."); }} className="w-full bg-black text-white py-3 rounded-lg font-medium hover:bg-gray-800 transition-colors flex items-center justify-center gap-2"><CheckCircle size={18} /> Approve & Qualify Driver</button>
                  <button onClick={() => onUpdateDriver(driver.id, { status: LeadStatus.REJECTED })} className="w-full mt-3 text-red-600 py-3 rounded-lg font-medium hover:bg-red-50 transition-colors flex items-center justify-center gap-2"><UserX size={18} /> Reject Application</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
