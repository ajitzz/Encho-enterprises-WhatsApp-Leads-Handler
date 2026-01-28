
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Driver, Message, LeadStatus, OnboardingStep, DriverDocument, ScheduledMessage } from '../types';
import { 
  X, Send, Image as ImageIcon, Video, CheckCircle, UserX, Car, Clock, 
  ShieldCheck, ChevronRight, Facebook, Globe, Headset, MicOff, Phone, 
  FileText, Sparkles, MapPin, ExternalLink, LayoutTemplate, Calendar,
  Download, Eye, AlertCircle, File, List, Filter, AlertTriangle, ArrowUp,
  Check, CheckCheck, Timer, Paperclip, Cloud, Edit2, Trash2, Zap
} from 'lucide-react';
import { liveApiService } from '../services/liveApiService';
import { MediaSelectorModal } from './MediaSelectorModal';

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
  
  // Media Attachment State
  const [showMediaPicker, setShowMediaPicker] = useState(false);
  const [selectedMedia, setSelectedMedia] = useState<{url: string, type: 'image' | 'video' | 'document'} | null>(null);

  // Document State
  const [documents, setDocuments] = useState<DriverDocument[]>([]);
  const [docLoading, setDocLoading] = useState(false);
  const [docFilter, setDocFilter] = useState<'all' | 'license' | 'rc_book' | 'id_proof'>('all');
  
  // Message History State
  const [loadingHistory, setLoadingHistory] = useState(false);
  
  // Scheduled Messages State
  const [scheduledMessages, setScheduledMessages] = useState<ScheduledMessage[]>([]);
  const [loadingScheduled, setLoadingScheduled] = useState(false);
  
  // Edit Scheduled Modal
  const [editingMessage, setEditingMessage] = useState<ScheduledMessage | null>(null);
  const [editTime, setEditTime] = useState('');
  const [editText, setEditText] = useState('');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const messages = driver && Array.isArray(driver.messages) ? driver.messages : [];

  useEffect(() => {
    if (messagesEndRef.current && !loadingHistory) {
        messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, driver?.id]);

  useEffect(() => {
    if (driver) {
        setLocalNotes(driver.notes || '');
        loadDocuments(driver.id);
        loadScheduledMessages(driver.id);
        
        // Poll for scheduled updates every 10s
        const interval = setInterval(() => loadScheduledMessages(driver.id), 10000);
        return () => clearInterval(interval);
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
              onUpdateDriver(driver.id, { isHumanMode: false });
          } else {
              const minutes = Math.floor(diff / 60000);
              const seconds = Math.floor((diff % 60000) / 1000);
              setTimeLeft(`${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`);
          }
      };

      updateTimer(); 
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

  const loadScheduledMessages = async (driverId: string) => {
      // Background load, don't show spinner every time
      try {
          const items = await liveApiService.getScheduledMessages(driverId);
          setScheduledMessages(items);
      } catch(e) {
          console.error("Failed scheduled fetch", e);
      }
  };

  const handleCancelScheduled = async (msgId: string) => {
      if (!window.confirm("Cancel this scheduled message?")) return;
      try {
          await liveApiService.cancelScheduledMessage(msgId);
          setScheduledMessages(prev => prev.filter(m => m.id !== msgId));
      } catch (e: any) {
          alert(`Error: ${e.message || "Could not cancel. It might be sending already."}`);
      }
  };
  
  const handleSendNowScheduled = async (msgId: string) => {
      if (!window.confirm("Send this message immediately?")) return;
      try {
          // Send update with sendNow flag
          await liveApiService.updateScheduledMessage(msgId, {
              text: undefined, // No text change
              scheduledTime: undefined,
          } as any); 
          // Note: The API call logic for sendNow is effectively handled by updateScheduledMessage 
          // if we pass a special flag or just set time to now.
          // Since the API signature in component might need adjustment, let's do it via update:
          await liveApiService.updateScheduledMessage(msgId, { scheduledTime: Date.now() });
          
          // Optimistic remove
          setScheduledMessages(prev => prev.filter(m => m.id !== msgId));
          alert("Message queued for immediate delivery.");
      } catch (e: any) {
          alert(`Error: ${e.message}`);
      }
  };

  const openEditModal = (msg: ScheduledMessage) => {
      setEditingMessage(msg);
      setEditText(msg.payload.text || '');
      // Format local time for input datetime-local
      const date = new Date(msg.scheduledTime);
      const isoString = new Date(date.getTime() - (date.getTimezoneOffset() * 60000)).toISOString().slice(0, 16);
      setEditTime(isoString);
  };

  const saveEditedMessage = async () => {
      if (!editingMessage || !editTime) return;
      const timestamp = new Date(editTime).getTime();
      
      if (timestamp <= Date.now()) {
          alert("Time must be in the future for editing. Use 'Send Now' instead.");
          return;
      }

      try {
          await liveApiService.updateScheduledMessage(editingMessage.id, {
              text: editText,
              scheduledTime: timestamp
          });
          setEditingMessage(null);
          if (driver) loadScheduledMessages(driver.id);
      } catch(e: any) {
          alert(`Update failed: ${e.message}`);
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
              onUpdateDriver(driver.id, { messages: newMessages });
          }
      } catch(e) { console.error("History load failed", e); } finally { setLoadingHistory(false); }
  };

  const filteredDocuments = useMemo(() => {
      if (docFilter === 'all') return documents;
      return documents.filter(d => d.docType === docFilter);
  }, [documents, docFilter]);

  if (!driver) return null;

  const handleSend = async () => {
    if (!replyText.trim() && !templateName && !selectedMedia) return;
    
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
                    mediaUrl: selectedMedia?.url,
                    mediaType: selectedMedia?.type
                }, 
                timestamp
            );
            loadScheduledMessages(driver.id);
            setReplyText(''); setTemplateName(''); setIsTemplateMode(false); setShowSchedule(false); setScheduleTime(''); setSelectedMedia(null);
        } catch(e: any) { alert(`Failed to schedule: ${e.message}`); }
    } else if (isTemplateMode && templateName) {
        try {
            await liveApiService.sendMessage(driver.id, replyText, { templateName });
            onUpdateDriver(driver.id, { lastMessage: `[Template: ${templateName}]`, lastMessageTime: Date.now() });
            setReplyText(''); setTemplateName(''); setIsTemplateMode(false);
        } catch(e: any) { alert(`Failed: ${e.message}`); }
    } else if (selectedMedia) {
        try {
            await liveApiService.sendMessage(driver.id, replyText, { mediaUrl: selectedMedia.url, mediaType: selectedMedia.type });
            onUpdateDriver(driver.id, { lastMessage: `[Sent ${selectedMedia.type}] ${replyText}`, lastMessageTime: Date.now() });
            setReplyText(''); setSelectedMedia(null);
        } catch(e: any) { alert(`Failed: ${e.message}`); }
    } else {
        try {
            await onSendMessage(replyText);
            setReplyText('');
        } catch(e: any) { alert(`Failed: ${e.message}`); }
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } };
  const toggleHumanMode = () => { onUpdateDriver(driver.id, { isHumanMode: !driver.isHumanMode }); };
  const handleMediaSelect = (url: string, type: 'image' | 'video' | 'document') => { setSelectedMedia({ url, type }); setShowMediaPicker(false); };

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
              
              {driver.isHumanMode && (
                  <div className="absolute top-0 left-0 right-0 bg-amber-50 border-b border-amber-200 p-3 z-20 flex items-center justify-between text-xs font-bold text-amber-900 shadow-sm animate-in slide-in-from-top-2">
                      <div className="flex items-center gap-2"><Headset size={16} className="text-amber-600 animate-pulse" /><span>Automation Paused.</span></div>
                      <div className="flex items-center gap-2 bg-amber-100 px-3 py-1 rounded-full border border-amber-200 font-mono"><Timer size={14} /><span>{timeLeft} remaining</span></div>
                  </div>
              )}

              <div ref={messagesContainerRef} className={`flex-1 overflow-y-auto p-4 bg-gray-50 space-y-4 ${driver.isHumanMode ? 'pt-16' : ''}`}>
                {messages.length >= 50 && (
                    <div className="flex justify-center py-2"><button onClick={handleLoadMore} disabled={loadingHistory} className="text-xs bg-white border border-gray-300 rounded-full px-4 py-2 shadow-sm text-gray-600 hover:bg-gray-100 flex items-center gap-2 disabled:opacity-50">{loadingHistory ? 'Loading...' : <><ArrowUp size={12} /> Load Previous Messages</>}</button></div>
                )}

                {/* Normal Messages */}
                {messages.length > 0 ? (
                    messages.map((msg) => (
                    <div key={msg.id} className={`flex ${msg.sender === 'driver' ? 'justify-start' : 'justify-end'}`}>
                        <div className={`max-w-[80%] rounded-2xl shadow-sm overflow-hidden ${msg.sender === 'driver' ? 'bg-white text-gray-900 rounded-tl-none border border-gray-200' : 'bg-blue-600 text-white rounded-tr-none'}`}>
                            {(msg.headerImageUrl || msg.imageUrl) && (<div className="w-full aspect-video overflow-hidden bg-black/5 relative group"><img src={msg.headerImageUrl || msg.imageUrl} alt="Header" className="w-full h-full object-cover" /></div>)}
                            <div className="px-4 py-3">
                                {msg.templateName && <div className="text-[10px] uppercase font-bold opacity-50 mb-1 flex items-center gap-1"><LayoutTemplate size={10} /> Template: {msg.templateName}</div>}
                                {msg.text && <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.text}</p>}
                                <div className={`text-[10px] mt-1 text-right opacity-60 flex items-center justify-end gap-1`}>{new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}{msg.sender !== 'driver' && msg.status && <span className={`capitalize flex items-center gap-1`}>{msg.status === 'read' && <CheckCheck size={12} className="text-blue-300" />} {msg.status}</span>}</div>
                            </div>
                        </div>
                    </div>
                    ))
                ) : <div className="h-full flex items-center justify-center text-gray-400 text-sm">No messages yet</div>}
                
                {/* SCHEDULED MESSAGES (GHOST BUBBLES) - NOW INTEGRATED INTO CHAT STREAM */}
                {scheduledMessages.length > 0 && (
                    <div className="space-y-4 pt-4 relative">
                        <div className="flex items-center gap-4 justify-center">
                            <div className="h-px bg-gray-300 w-12"></div>
                            <span className="text-xs font-bold text-gray-400 uppercase tracking-wider flex items-center gap-1"><Clock size={12} /> Scheduled Queue</span>
                            <div className="h-px bg-gray-300 w-12"></div>
                        </div>
                        
                        {scheduledMessages.map(msg => (
                            <div key={msg.id} className="flex justify-end animate-in fade-in slide-in-from-bottom-2">
                                <div className="max-w-[80%] rounded-2xl rounded-tr-none border-2 border-dashed border-amber-300 bg-amber-50/50 p-4 shadow-sm relative group hover:bg-amber-50 transition-all">
                                    {/* Action Overlay */}
                                    <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-white/80 backdrop-blur rounded-lg p-1 shadow-sm border border-amber-100">
                                        <button onClick={() => handleSendNowScheduled(msg.id)} className="p-1.5 text-green-600 hover:bg-green-50 rounded" title="Send Now"><Zap size={14} /></button>
                                        <button onClick={() => openEditModal(msg)} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded" title="Edit"><Edit2 size={14} /></button>
                                        <button onClick={() => handleCancelScheduled(msg.id)} className="p-1.5 text-red-600 hover:bg-red-50 rounded" title="Cancel"><Trash2 size={14} /></button>
                                    </div>

                                    <div className="flex items-center gap-2 mb-2 text-amber-700">
                                        <Clock size={14} />
                                        <span className="text-xs font-bold font-mono">
                                            {new Date(msg.scheduledTime).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'})}
                                        </span>
                                        {msg.status === 'processing' && <span className="text-[10px] bg-amber-200 px-1.5 rounded animate-pulse">Sending...</span>}
                                        {msg.status === 'failed' && <span className="text-[10px] bg-red-200 text-red-800 px-1.5 rounded">Retry Failed</span>}
                                    </div>
                                    
                                    <p className="text-sm text-gray-600 italic">
                                        {msg.payload.text || (msg.payload.mediaType ? `[Media: ${msg.payload.mediaType}]` : '[No Text]')}
                                    </p>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
                
                <div ref={messagesEndRef} />
              </div>

              <div className="p-4 bg-white border-t border-gray-200 relative">
                {showSchedule && (
                    <div className="absolute bottom-[calc(100%+10px)] left-4 right-4 bg-white rounded-xl shadow-2xl border border-gray-200 p-4 animate-in slide-in-from-bottom-5 fade-in duration-200 z-20">
                        <div className="flex items-center justify-between mb-3 border-b border-gray-100 pb-2">
                            <h4 className="font-bold text-gray-800 flex items-center gap-2"><Calendar size={16} className="text-amber-500" /> Schedule Message</h4>
                            <button onClick={() => setShowSchedule(false)} className="p-1 hover:bg-gray-100 rounded-full transition-colors"><X size={16} className="text-gray-400" /></button>
                        </div>
                        <div className="space-y-3">
                            <div>
                                <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Pick Date & Time (Local)</label>
                                <input type="datetime-local" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} className="w-full p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-amber-500 transition-all" />
                            </div>
                            <p className="text-[10px] text-gray-400">Message will be sent automatically by the server at the selected time.</p>
                        </div>
                    </div>
                )}

                <div className="flex gap-2 mb-3">
                    <button onClick={() => setShowMediaPicker(true)} className={`px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-1 transition-all border bg-white text-gray-600 border-gray-200 hover:bg-gray-50`} title="Attach Media"><Paperclip size={12} /> Attach</button>
                    <button onClick={() => setIsTemplateMode(!isTemplateMode)} className={`px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-1 transition-all border ${isTemplateMode ? 'bg-purple-100 text-purple-700 border-purple-200' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`} title="Send Template"><LayoutTemplate size={12} /> Template</button>
                    <button onClick={() => setShowSchedule(!showSchedule)} className={`px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-1 transition-all border ${showSchedule ? 'bg-amber-100 text-amber-700 border-amber-200' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`} title="Schedule Message"><Clock size={12} /> {scheduleTime ? 'Scheduled' : 'Schedule'}</button>
                </div>

                <div className="flex gap-3">
                  <textarea value={replyText} onChange={(e) => setReplyText(e.target.value)} onKeyDown={handleKeyPress} placeholder={isTemplateMode ? "Body Parameter..." : "Type a message..."} className="flex-1 resize-none border border-gray-300 rounded-xl p-3 focus:outline-none focus:ring-2 focus:ring-blue-500 h-20 shadow-inner" />
                  <button onClick={handleSend} disabled={(!replyText.trim() && !templateName && !selectedMedia) || (showSchedule && !scheduleTime)} className={`self-end p-3 rounded-xl shadow-lg disabled:opacity-50 transition-all flex items-center justify-center w-12 h-12 ${showSchedule ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-black hover:bg-gray-800 text-white'}`}>{showSchedule ? <Clock size={20} /> : <Send size={20} />}</button>
                </div>
              </div>
            </div>

            {/* Right: Profile */}
            <div className="w-[450px] bg-white flex flex-col overflow-y-auto border-l border-gray-200">
              <div className="p-6 border-b border-gray-100 bg-gray-50/50">
                <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Documents</h3>
                    <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg p-0.5">
                        <button onClick={() => setDocFilter('all')} className={`px-2 py-1 text-[10px] font-bold rounded ${docFilter === 'all' ? 'bg-gray-100 text-black' : 'text-gray-400'}`}>All</button>
                        <button onClick={() => setDocFilter('license')} className={`px-2 py-1 text-[10px] font-bold rounded ${docFilter === 'license' ? 'bg-blue-50 text-blue-600' : 'text-gray-400'}`}>License</button>
                        <button onClick={() => setDocFilter('rc_book')} className={`px-2 py-1 text-[10px] font-bold rounded ${docFilter === 'rc_book' ? 'bg-purple-50 text-purple-600' : 'text-gray-400'}`}>RC</button>
                    </div>
                </div>
                <div className="space-y-3">
                    {filteredDocuments.map((doc) => (
                        <div key={doc.id} className="bg-white p-3 rounded-xl border border-gray-200 shadow-sm flex items-center justify-between">
                            <span className="text-xs font-bold capitalize">{doc.docType.replace('_', ' ')}</span>
                            <span className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase ${doc.verificationStatus === 'approved' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>{doc.verificationStatus}</span>
                        </div>
                    ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      {/* EDIT SCHEDULED MESSAGE MODAL */}
      {editingMessage && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
              <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm animate-in zoom-in-95 overflow-hidden">
                  <div className="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
                      <h3 className="font-bold text-gray-900 flex items-center gap-2"><Edit2 size={16} className="text-blue-600" /> Edit Scheduled Message</h3>
                      <button onClick={() => setEditingMessage(null)}><X size={18} className="text-gray-400 hover:text-gray-600" /></button>
                  </div>
                  <div className="p-6 space-y-4">
                      <div>
                          <label className="block text-xs font-bold text-gray-500 uppercase mb-1">New Time</label>
                          <input type="datetime-local" value={editTime} onChange={(e) => setEditTime(e.target.value)} className="w-full p-2 border border-gray-300 rounded-lg text-sm" />
                      </div>
                      <div>
                          <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Message Text</label>
                          <textarea value={editText} onChange={(e) => setEditText(e.target.value)} className="w-full p-3 border border-gray-300 rounded-lg text-sm h-24 resize-none" />
                      </div>
                      <button onClick={saveEditedMessage} className="w-full bg-blue-600 text-white py-2 rounded-lg font-bold hover:bg-blue-700 transition-colors">Save Changes</button>
                  </div>
              </div>
          </div>
      )}

      <MediaSelectorModal isOpen={showMediaPicker} onClose={() => setShowMediaPicker(false)} onSelect={handleMediaSelect} allowedType="All" />
    </div>
  );
};
