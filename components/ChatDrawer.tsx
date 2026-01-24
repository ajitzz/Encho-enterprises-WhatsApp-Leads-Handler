
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Driver, Message, LeadStatus, OnboardingStep, DriverDocument } from '../types';
import { 
  X, Send, Image as ImageIcon, Video, CheckCircle, UserX, Car, Clock, 
  ShieldCheck, ChevronRight, Facebook, Globe, Headset, MicOff, Phone, 
  FileText, Sparkles, MapPin, ExternalLink, LayoutTemplate, Calendar,
  Download, Eye, AlertCircle, File, List, Filter, AlertTriangle, ArrowUp,
  Check, CheckCheck, Timer
} from 'lucide-react';
import { liveApiService } from '../services/liveApiService';

interface ChatDrawerProps {
  driver: Driver | null;
  onClose: () => void;
  onSendMessage: (text: string) => void;
  onUpdateDriver: (id: string, updates: Partial<Driver>) => void;
}

const REQUIRED_DOCS = [
    { type: 'license', label: 'Driving License' },
    { type: 'rc_book', label: 'Vehicle RC' },
    { type: 'id_proof', label: 'ID Proof (Aadhaar/PAN)' }
];

export const ChatDrawer: React.FC<ChatDrawerProps> = ({ driver, onClose, onSendMessage, onUpdateDriver }) => {
  const [replyText, setReplyText] = useState('');
  const [localNotes, setLocalNotes] = useState('');
  const [isTemplateMode, setIsTemplateMode] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleTime, setScheduleTime] = useState('');
  const [timeLeft, setTimeLeft] = useState<string>('');
  
  // Document State
  const [documents, setDocuments] = useState<DriverDocument[]>([]);
  const [docLoading, setDocLoading] = useState(false);
  const [docFilter, setDocFilter] = useState<'all' | 'license' | 'rc_book' | 'id_proof'>('all');
  
  // Message History State
  const [loadingHistory, setLoadingHistory] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const messages = driver && Array.isArray(driver.messages) ? driver.messages : [];

  // Scroll to bottom on initial load or new message
  useEffect(() => {
    if (messagesEndRef.current && !loadingHistory) {
        messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, driver?.id]);

  useEffect(() => {
    if (driver) {
        setLocalNotes(driver.notes || '');
        loadDocuments(driver.id);
    }
  }, [driver]);

  // COUNTDOWN TIMER LOGIC
  useEffect(() => {
      if (!driver?.isHumanMode || !driver?.humanModeEndsAt) {
          setTimeLeft('');
          return;
      }

      const updateTimer = () => {
          const now = Date.now();
          const diff = (driver.humanModeEndsAt || 0) - now;
          
          if (diff <= 0) {
              setTimeLeft('00:00');
              // Optionally trigger an update locally if backend hasn't synced yet
              if (driver.isHumanMode) {
                  onUpdateDriver(driver.id, { isHumanMode: false });
              }
          } else {
              const minutes = Math.floor(diff / 60000);
              const seconds = Math.floor((diff % 60000) / 1000);
              setTimeLeft(`${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`);
          }
      };

      updateTimer(); // Initial call
      const interval = setInterval(updateTimer, 1000);
      return () => clearInterval(interval);
  }, [driver?.isHumanMode, driver?.humanModeEndsAt, driver?.id]);

  const loadDocuments = async (driverId: string) => {
      setDocLoading(true);
      try {
          const docs = await liveApiService.getDriverDocuments(driverId);
          setDocuments(docs);
      } catch(e) {
          console.error("Failed to load docs", e);
      } finally {
          setDocLoading(false);
      }
  };

  const handleLoadMore = async () => {
      if (!driver || messages.length === 0) return;
      
      const oldestMessage = messages[0];
      const beforeTimestamp = oldestMessage.timestamp;
      
      setLoadingHistory(true);
      try {
          const olderMessages = await liveApiService.getDriverMessages(driver.id, 50, beforeTimestamp);
          
          if (olderMessages.length > 0) {
              const newMessages = [...olderMessages, ...messages];
              // Update parent state directly (optimistic update for visual)
              onUpdateDriver(driver.id, { messages: newMessages });
          }
      } catch(e) {
          console.error("Failed to load history", e);
      } finally {
          setLoadingHistory(false);
      }
  };

  const handleUpdateDocStatus = async (docId: string, status: 'approved' | 'rejected') => {
      try {
          await liveApiService.updateDocumentStatus(docId, status);
          // Optimistic update
          setDocuments(prev => prev.map(d => d.id === docId ? { ...d, verificationStatus: status } : d));
      } catch(e) {
          alert("Failed to update status");
      }
  };

  const filteredDocuments = useMemo(() => {
      if (docFilter === 'all') return documents;
      return documents.filter(d => d.docType === docFilter);
  }, [documents, docFilter]);

  // Checklist Logic
  const checklistStatus = useMemo(() => {
      return REQUIRED_DOCS.map(req => {
          const found = documents.find(d => d.docType === req.type && d.verificationStatus !== 'rejected');
          return { ...req, isUploaded: !!found, isApproved: found?.verificationStatus === 'approved' };
      });
  }, [documents]);

  const handleRequestMissingDocs = async () => {
      if (!driver) return;
      const missing = checklistStatus.filter(c => !c.isUploaded).map(c => c.label);
      if (missing.length === 0) {
          alert("All required documents are uploaded!");
          return;
      }
      const msg = `Hello ${driver.name}, please upload the following documents to complete your application:\n- ${missing.join('\n- ')}`;
      await onSendMessage(msg);
      alert("Request sent successfully.");
  };

  if (!driver) return null;

  const handleSend = async () => {
    if (!replyText.trim() && !templateName) return;
    
    // 1. Scheduled Message Path
    if (showSchedule && scheduleTime) {
        const timestamp = new Date(scheduleTime).getTime();
        if (isNaN(timestamp) || timestamp <= Date.now()) {
            alert("Please select a future date and time.");
            return;
        }

        try {
            await liveApiService.scheduleMessage(
                [driver.id], 
                {
                    text: replyText,
                    templateName: isTemplateMode ? templateName : undefined,
                }, 
                timestamp
            );

            onUpdateDriver(driver.id, { 
                lastMessage: `[Scheduled for ${new Date(timestamp).toLocaleTimeString()}]`, 
                lastMessageTime: Date.now() 
            });
            
            // Clean up UI
            setReplyText('');
            setTemplateName('');
            setIsTemplateMode(false);
            setShowSchedule(false);
            setScheduleTime('');
            
        } catch(e: any) {
            console.error("Schedule Error:", e);
            alert(`Failed to schedule: ${e.message}`);
        }
    } 
    // 2. Immediate Template Path
    else if (isTemplateMode && templateName) {
        try {
            await liveApiService.sendMessage(driver.id, replyText, { templateName });
            onUpdateDriver(driver.id, { 
                lastMessage: `[Template: ${templateName}]`, 
                lastMessageTime: Date.now() 
            });
            setReplyText('');
            setTemplateName('');
            setIsTemplateMode(false);
        } catch(e: any) {
            alert(`Failed to send template: ${e.message}`);
        }
    } 
    // 3. Standard Text Path
    else {
        try {
            // FIX: Use parent prop handler to ensure immediate UI update (optimistic)
            await onSendMessage(replyText);
            setReplyText('');
        } catch(e: any) {
            alert(`Message Failed: ${e.message}`);
        }
    }
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
      // If turning ON, backend will set the timer. If OFF, it clears it.
      onUpdateDriver(driver.id, { isHumanMode: newState });
      
      if (newState) {
          // Send a system note (not a WhatsApp message) locally to show start
          // onSendMessage("System: Human Agent Mode Activated (30min Timer Started)");
      }
  };

  const handleVoiceCall = () => {
      onSendMessage("📞 Uber Fleet: Incoming Voice Call Request. Please click here to join: https://meet.google.com/call-voice-mock");
      alert("Voice Call Request Sent to Driver's WhatsApp");
  };

  const handleVideoCall = () => {
      onSendMessage("📹 Uber Fleet: Incoming Video Call Request. Please click here to join: https://meet.google.com/call-video-mock");
      alert("Video Call Request Sent to Driver's WhatsApp");
  };

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm transition-opacity" onClick={onClose} />
      
      <div className="absolute inset-y-0 right-0 flex max-w-full pl-10 pointer-events-none">
        <div className="pointer-events-auto w-screen max-w-5xl bg-white shadow-2xl flex flex-col h-full">
          
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
                    <button onClick={toggleHumanMode} className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-bold transition-all ${driver.isHumanMode ? 'bg-amber-500 text-black' : 'text-gray-400 hover:text-white'}`} title={driver.isHumanMode ? 'Click to Stop Human Mode' : 'Click to Takeover (30 mins)'}>
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
              
              {/* HUMAN MODE BANNER & COUNTDOWN */}
              {driver.isHumanMode && (
                  <div className="absolute top-0 left-0 right-0 bg-amber-50 border-b border-amber-200 p-3 z-20 flex items-center justify-between text-xs font-bold text-amber-900 shadow-sm animate-in slide-in-from-top-2">
                      <div className="flex items-center gap-2">
                          <Headset size={16} className="text-amber-600 animate-pulse" />
                          <span>Automation Paused. You are in manual control.</span>
                      </div>
                      <div className="flex items-center gap-2 bg-amber-100 px-3 py-1 rounded-full border border-amber-200 font-mono">
                          <Timer size={14} />
                          <span>{timeLeft} remaining</span>
                      </div>
                  </div>
              )}

              <div 
                ref={messagesContainerRef}
                className={`flex-1 overflow-y-auto p-4 bg-gray-50 space-y-4 ${driver.isHumanMode ? 'pt-16' : ''}`}
              >
                {/* Pagination Trigger */}
                {messages.length >= 50 && (
                    <div className="flex justify-center py-2">
                        <button 
                            onClick={handleLoadMore} 
                            disabled={loadingHistory}
                            className="text-xs bg-white border border-gray-300 rounded-full px-4 py-2 shadow-sm text-gray-600 hover:bg-gray-100 flex items-center gap-2 disabled:opacity-50"
                        >
                            {loadingHistory ? 'Loading...' : <><ArrowUp size={12} /> Load Previous Messages</>}
                        </button>
                    </div>
                )}

                {messages.length > 0 ? (
                    messages.map((msg) => (
                    <div key={msg.id} className={`flex ${msg.sender === 'driver' ? 'justify-start' : 'justify-end'}`}>
                        <div className={`max-w-[80%] rounded-2xl shadow-sm overflow-hidden ${msg.sender === 'driver' ? 'bg-white text-gray-900 rounded-tl-none border border-gray-200' : 'bg-blue-600 text-white rounded-tr-none'}`}>
                            
                            {/* RICH CARD HEADER IMAGE */}
                            {(msg.headerImageUrl || msg.imageUrl) && (
                                <div className="w-full aspect-video overflow-hidden bg-black/5 relative group">
                                    <img src={msg.headerImageUrl || msg.imageUrl} alt="Header" className="w-full h-full object-cover" />
                                    <a href={msg.headerImageUrl || msg.imageUrl} target="_blank" rel="noreferrer" className="absolute top-2 right-2 p-1 bg-black/50 text-white rounded opacity-0 group-hover:opacity-100 transition-opacity"><ExternalLink size={12} /></a>
                                </div>
                            )}

                            {/* MESSAGE BODY */}
                            <div className="px-4 py-3">
                                {msg.templateName && (
                                    <div className="text-[10px] uppercase font-bold opacity-50 mb-1 flex items-center gap-1">
                                        <LayoutTemplate size={10} /> Template: {msg.templateName}
                                    </div>
                                )}
                                
                                {msg.type === 'audio' && (
                                    <div className="flex items-center gap-2 my-2 bg-gray-100/20 p-2 rounded-lg">
                                        <Phone size={16} />
                                        <span className="text-xs italic">Audio Message (Format not supported in browser)</span>
                                    </div>
                                )}

                                {msg.type === 'document' && (
                                    <div className="flex items-center gap-2 my-2 bg-gray-100/20 p-3 rounded-lg border border-white/20">
                                        <FileText size={20} />
                                        <div className="flex-1 min-w-0">
                                            <div className="text-xs font-bold truncate">Document Received</div>
                                            <div className="text-[10px] opacity-70">Check Documents Tab</div>
                                        </div>
                                    </div>
                                )}

                                {msg.text && <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.text}</p>}
                                {msg.footerText && <p className={`text-[10px] mt-2 pt-2 border-t opacity-70 ${msg.sender === 'driver' ? 'border-gray-100' : 'border-blue-500'}`}>{msg.footerText}</p>}
                                <div className={`text-[10px] mt-1 text-right opacity-60 flex items-center justify-end gap-1`}>
                                    {new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                                    {msg.sender !== 'driver' && msg.status && (
                                        <span className={`capitalize flex items-center gap-1 ${msg.status === 'failed' ? 'text-red-300 font-bold' : ''}`}>
                                            {/* WhatsApp Style Ticks */}
                                            {msg.status === 'sent' && <Check size={12} />}
                                            {msg.status === 'delivered' && <CheckCheck size={12} />}
                                            {msg.status === 'read' && <CheckCheck size={12} className="text-blue-300" />}
                                            {msg.status}
                                        </span>
                                    )}
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

              <div className="p-4 bg-white border-t border-gray-200 relative">
                {/* MODERN SCHEDULE POPUP */}
                {showSchedule && (
                    <div className="absolute bottom-[calc(100%+10px)] left-4 right-4 bg-white rounded-xl shadow-2xl border border-gray-200 p-4 animate-in slide-in-from-bottom-5 fade-in duration-200 z-20">
                        <div className="flex items-center justify-between mb-3 border-b border-gray-100 pb-2">
                            <h4 className="font-bold text-gray-800 flex items-center gap-2">
                                <Calendar size={16} className="text-amber-500" />
                                Schedule Message
                            </h4>
                            <button onClick={() => setShowSchedule(false)} className="p-1 hover:bg-gray-100 rounded-full transition-colors"><X size={16} className="text-gray-400" /></button>
                        </div>
                        <div className="space-y-3">
                            <div>
                                <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Pick Date & Time (Local)</label>
                                <input 
                                    type="datetime-local"
                                    value={scheduleTime}
                                    onChange={(e) => setScheduleTime(e.target.value)}
                                    className="w-full p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-amber-500 transition-all"
                                />
                            </div>
                            <p className="text-[10px] text-gray-400">
                                Message will be sent automatically by the server at the selected time.
                            </p>
                        </div>
                    </div>
                )}

                {/* TEMPLATE INPUT */}
                {isTemplateMode && (
                    <div className="mb-2 bg-purple-50 p-2 rounded-lg border border-purple-100 flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2">
                        <span className="text-[10px] font-bold text-purple-700 uppercase">Template:</span>
                        <input 
                            value={templateName}
                            onChange={(e) => setTemplateName(e.target.value)}
                            placeholder="e.g. welcome_v2"
                            className="flex-1 bg-white border border-gray-200 rounded px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-purple-500"
                            autoFocus
                        />
                        <button onClick={() => setIsTemplateMode(false)} className="text-gray-400 hover:text-gray-600"><X size={14} /></button>
                    </div>
                )}

                <div className="flex gap-2 mb-3">
                    {/* Template Toggle */}
                    <button 
                        onClick={() => setIsTemplateMode(!isTemplateMode)}
                        className={`px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-1 transition-all border ${isTemplateMode ? 'bg-purple-100 text-purple-700 border-purple-200' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                        title="Send Template"
                    >
                        <LayoutTemplate size={12} /> Template
                    </button>

                    {/* Schedule Toggle */}
                    <button 
                        onClick={() => setShowSchedule(!showSchedule)}
                        className={`px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-1 transition-all border ${showSchedule ? 'bg-amber-100 text-amber-700 border-amber-200' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                        title="Schedule Message"
                    >
                        <Clock size={12} /> {scheduleTime ? 'Scheduled' : 'Schedule'}
                    </button>
                </div>

                <div className="flex gap-3">
                  <textarea value={replyText} onChange={(e) => setReplyText(e.target.value)} onKeyDown={handleKeyPress} placeholder={isTemplateMode ? "Body Parameter (e.g. User Name)..." : "Type a message..."} className="flex-1 resize-none border border-gray-300 rounded-xl p-3 focus:outline-none focus:ring-2 focus:ring-blue-500 h-20 shadow-inner" />
                  
                  <button 
                    onClick={handleSend} 
                    disabled={(!replyText.trim() && !templateName) || (showSchedule && !scheduleTime)} 
                    className={`self-end p-3 rounded-xl shadow-lg disabled:opacity-50 transition-all flex items-center justify-center w-12 h-12 ${showSchedule ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-black hover:bg-gray-800 text-white'}`}
                    title={showSchedule ? "Schedule Message" : "Send Now"}
                  >
                      {showSchedule ? <Clock size={20} /> : <Send size={20} />}
                  </button>
                </div>
              </div>
            </div>

            {/* Right: Driver Profile & Documents */}
            <div className="w-[450px] bg-white flex flex-col overflow-y-auto border-l border-gray-200">
              
              {/* Profile Summary */}
              <div className="p-6 border-b border-gray-100 bg-gray-50/50">
                <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Documents</h3>
                    <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg p-0.5">
                        <button onClick={() => setDocFilter('all')} className={`px-2 py-1 text-[10px] font-bold rounded ${docFilter === 'all' ? 'bg-gray-100 text-black' : 'text-gray-400'}`}>All</button>
                        <button onClick={() => setDocFilter('license')} className={`px-2 py-1 text-[10px] font-bold rounded ${docFilter === 'license' ? 'bg-blue-50 text-blue-600' : 'text-gray-400'}`}>License</button>
                        <button onClick={() => setDocFilter('rc_book')} className={`px-2 py-1 text-[10px] font-bold rounded ${docFilter === 'rc_book' ? 'bg-purple-50 text-purple-600' : 'text-gray-400'}`}>RC</button>
                    </div>
                </div>

                {/* Checklist Widget */}
                <div className="bg-white border border-gray-200 rounded-lg p-3 mb-4">
                    <h4 className="text-[10px] font-bold text-gray-400 uppercase mb-2">Required Verification</h4>
                    <div className="space-y-2">
                        {checklistStatus.map(item => (
                            <div key={item.type} className="flex items-center justify-between text-sm">
                                <span className={`flex items-center gap-2 ${item.isUploaded ? 'text-gray-800' : 'text-gray-400'}`}>
                                    {item.isUploaded ? <CheckCircle size={14} className={item.isApproved ? "text-green-500" : "text-amber-500"} /> : <div className="w-3.5 h-3.5 rounded-full border border-gray-300" />}
                                    {item.label}
                                </span>
                                {item.isUploaded && !item.isApproved && <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 rounded">Review</span>}
                            </div>
                        ))}
                    </div>
                    {checklistStatus.some(c => !c.isUploaded) && (
                        <button 
                            onClick={handleRequestMissingDocs}
                            className="w-full mt-3 text-xs bg-blue-50 text-blue-700 py-1.5 rounded font-bold hover:bg-blue-100 transition-colors border border-blue-100"
                        >
                            Request Missing Docs
                        </button>
                    )}
                </div>

                {docLoading ? (
                    <div className="flex items-center justify-center p-4 text-gray-400 text-sm italic">Loading docs...</div>
                ) : filteredDocuments.length === 0 ? (
                    <div className="flex flex-col items-center justify-center p-6 bg-white border border-gray-200 border-dashed rounded-xl">
                        <FileText size={24} className="text-gray-300 mb-2" />
                        <span className="text-xs text-gray-400">No {docFilter !== 'all' ? docFilter : ''} documents found.</span>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {filteredDocuments.map((doc) => (
                            <div key={doc.id} className={`bg-white p-3 rounded-xl border transition-colors shadow-sm group ${doc.verificationStatus === 'pending' ? 'border-amber-200 bg-amber-50/20' : 'border-gray-200 hover:border-blue-300'}`}>
                                <div className="flex items-start justify-between mb-2">
                                    <div className="flex items-center gap-2">
                                        <div className={`p-2 rounded-lg ${doc.mimeType?.includes('image') ? 'bg-blue-50 text-blue-600' : 'bg-orange-50 text-orange-600'}`}>
                                            {doc.mimeType?.includes('image') ? <ImageIcon size={16} /> : <File size={16} />}
                                        </div>
                                        <div>
                                            <span className="text-xs font-bold text-gray-800 block capitalize">{doc.docType.replace('_', ' ')}</span>
                                            <span className="text-[10px] text-gray-400">{new Date(doc.createdAt).toLocaleDateString()}</span>
                                        </div>
                                    </div>
                                    
                                    <div className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${
                                        doc.verificationStatus === 'approved' ? 'bg-green-100 text-green-700' : 
                                        doc.verificationStatus === 'rejected' ? 'bg-red-100 text-red-700' : 
                                        'bg-yellow-100 text-yellow-700'
                                    }`}>
                                        {doc.verificationStatus}
                                    </div>
                                </div>
                                
                                {doc.verificationStatus === 'failed' && (
                                    <div className="mb-2 text-[10px] text-red-600 bg-red-50 p-1.5 rounded border border-red-100 flex items-center gap-1">
                                        <AlertTriangle size={10} />
                                        Upload Failed. Ask to resend.
                                    </div>
                                )}
                                
                                {doc.mimeType?.includes('image') && doc.fileUrl && (
                                    <div className="aspect-[4/3] w-full bg-gray-100 rounded-lg mb-3 overflow-hidden relative cursor-pointer" onClick={() => window.open(doc.fileUrl, '_blank')}>
                                        <img src={doc.fileUrl} alt="Preview" className="w-full h-full object-cover hover:scale-105 transition-transform" />
                                    </div>
                                )}

                                <div className="flex gap-2">
                                    {doc.fileUrl && (
                                        <a href={doc.fileUrl} target="_blank" rel="noreferrer" className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 py-1.5 rounded-lg text-xs font-medium flex items-center justify-center gap-1 transition-colors">
                                            <Eye size={12} /> View
                                        </a>
                                    )}
                                    
                                    {doc.verificationStatus !== 'approved' && (
                                        <button onClick={() => handleUpdateDocStatus(doc.id, 'approved')} className="flex-1 bg-green-50 hover:bg-green-100 text-green-700 border border-green-200 py-1.5 rounded-lg text-xs font-bold flex items-center justify-center gap-1 transition-colors">
                                            <CheckCircle size={12} /> Approve
                                        </button>
                                    )}
                                    {doc.verificationStatus !== 'rejected' && (
                                        <button onClick={() => handleUpdateDocStatus(doc.id, 'rejected')} className="bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 p-1.5 rounded-lg transition-colors" title="Reject">
                                            <X size={14} />
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
              </div>

              <div className="p-6 space-y-8 flex-1">
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
