
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Driver, Message, LeadStatus, ScheduledMessage, DriverDocument } from '../types';
import { 
  X, Send, Image as ImageIcon, Video, CheckCircle, Headset, MicOff, Phone, 
  FileText, Calendar, Clock, Paperclip, LayoutTemplate, Edit2, Trash2, Zap, Globe, Facebook, AlertTriangle
} from 'lucide-react';
import { liveApiService } from '../services/liveApiService';
import { MediaSelectorModal } from './MediaSelectorModal';

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
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleTime, setScheduleTime] = useState('');
  const [timeLeft, setTimeLeft] = useState<string>('');
  
  const [showMediaPicker, setShowMediaPicker] = useState(false);
  const [selectedMedia, setSelectedMedia] = useState<{url: string, type: 'image' | 'video' | 'document'} | null>(null);

  const [documents, setDocuments] = useState<DriverDocument[]>([]);
  const [docFilter, setDocFilter] = useState<'all' | 'license' | 'rc_book' | 'id_proof'>('all');
  
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [scheduledMessages, setScheduledMessages] = useState<ScheduledMessage[]>([]);
  
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
        const interval = setInterval(() => loadScheduledMessages(driver.id), 10000);
        return () => clearInterval(interval);
    }
  }, [driver]);

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
      try { 
          const docs = await liveApiService.getDriverDocuments(driverId); 
          setDocuments(docs || []); 
      } catch(e) {
          setDocuments([]);
      }
  };
  const loadScheduledMessages = async (driverId: string) => {
      try { const items = await liveApiService.getScheduledMessages(driverId); setScheduledMessages(items); } catch(e) {}
  };
  const handleCancelScheduled = async (msgId: string) => {
      if (!window.confirm("Cancel this scheduled message?")) return;
      try { await liveApiService.cancelScheduledMessage(msgId); setScheduledMessages(prev => prev.filter(m => m.id !== msgId)); } catch (e: any) { alert(`Error: ${e.message}`); }
  };
  const handleSendNowScheduled = async (msgId: string) => {
      if (!window.confirm("Send this message immediately?")) return;
      try { await liveApiService.updateScheduledMessage(msgId, { scheduledTime: Date.now() }); setScheduledMessages(prev => prev.filter(m => m.id !== msgId)); alert("Message queued for immediate delivery."); } catch (e: any) { alert(`Error: ${e.message}`); }
  };
  const openEditModal = (msg: ScheduledMessage) => {
      setEditingMessage(msg);
      setEditText(msg.payload.text || '');
      const date = new Date(msg.scheduledTime);
      const isoString = new Date(date.getTime() - (date.getTimezoneOffset() * 60000)).toISOString().slice(0, 16);
      setEditTime(isoString);
  };
  const saveEditedMessage = async () => {
      if (!editingMessage || !editTime) return;
      if (new Date(editTime).getTime() <= Date.now()) { alert("Time must be in the future."); return; }
      try { await liveApiService.updateScheduledMessage(editingMessage.id, { text: editText, scheduledTime: new Date(editTime).getTime() }); setEditingMessage(null); if (driver) loadScheduledMessages(driver.id); } catch(e: any) { alert(`Update failed: ${e.message}`); }
  };
  const handleLoadMore = async () => {
      if (!driver || messages.length === 0) return;
      setLoadingHistory(true);
      try { const olderMessages = await liveApiService.getDriverMessages(driver.id, 50, messages[0].timestamp); if (olderMessages.length > 0) onUpdateDriver(driver.id, { messages: [...olderMessages, ...messages] }); } catch(e) {} finally { setLoadingHistory(false); }
  };
  const filteredDocuments = useMemo(() => {
      if (docFilter === 'all') return documents;
      return documents.filter(d => d.docType === docFilter);
  }, [documents, docFilter]);

  if (!driver) return null;

  const handleSend = async () => {
    // BLOCKED PHRASES CHECK
    const BLOCKED = ['replace this', 'sample message', 'type your message'];
    if (BLOCKED.some(b => replyText.toLowerCase().includes(b))) {
        alert("Please replace placeholder text before sending.");
        return;
    }

    if (!replyText.trim() && !templateName && !selectedMedia) return;
    
    if (showSchedule && scheduleTime) {
        const scheduledTs = new Date(scheduleTime).getTime();
        if (isNaN(scheduledTs)) { alert("Invalid date"); return; }
        if (scheduledTs <= Date.now()) { alert("Select a time in the future."); return; }
        
        try { 
            await liveApiService.scheduleMessage([driver.id], { text: replyText, templateName: isTemplateMode ? templateName : undefined, mediaUrl: selectedMedia?.url, mediaType: selectedMedia?.type }, scheduledTs); 
            setReplyText(''); 
            setShowSchedule(false);
            setScheduleTime('');
            alert("Message Scheduled Successfully!");
            await loadScheduledMessages(driver.id); 
        } catch(e: any) { 
            console.error(e);
            alert(`Scheduling Failed: ${e.message || "Server Error"}`); 
        }
    } else if (isTemplateMode && templateName) {
        try { await liveApiService.sendMessage(driver.id, replyText, { templateName }); setReplyText(''); setTemplateName(''); setIsTemplateMode(false); } catch(e: any) { alert(`Failed: ${e.message}`); }
    } else if (selectedMedia) {
        try { await liveApiService.sendMessage(driver.id, replyText, { mediaUrl: selectedMedia.url, mediaType: selectedMedia.type }); setReplyText(''); setSelectedMedia(null); } catch(e: any) { alert(`Failed: ${e.message}`); }
    } else {
        try { await onSendMessage(replyText); setReplyText(''); } catch(e: any) { alert(`Failed: ${e.message}`); }
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } };

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm transition-opacity" onClick={onClose} />
      <div className="absolute inset-y-0 right-0 flex max-w-full pl-10 pointer-events-none">
        <div className="pointer-events-auto w-screen max-w-5xl bg-white shadow-2xl flex flex-col h-full">
          <div className="bg-black text-white px-6 py-4 flex items-center justify-between shadow-md z-10">
            <div className="flex items-center gap-4">
               <div className="h-10 w-10 bg-gray-800 rounded-full flex items-center justify-center text-lg font-bold">{driver.name.charAt(0)}</div>
               <div>
                 <div className="flex items-center gap-2"><h2 className="text-xl font-semibold">{driver.name}</h2><span className="bg-gray-700 text-[10px] px-2 py-0.5 rounded-full">{driver.source}</span></div>
                 <p className="text-gray-400 text-sm font-mono">{driver.phoneNumber}</p>
               </div>
            </div>
            <div className="flex items-center gap-4">
               <div className="flex items-center gap-2 bg-gray-900 rounded-lg p-1 border border-gray-800">
                    <button onClick={() => onUpdateDriver(driver.id, { isHumanMode: !driver.isHumanMode })} className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-bold transition-all ${driver.isHumanMode ? 'bg-amber-500 text-black' : 'text-gray-400 hover:text-white'}`}>
                        {driver.isHumanMode ? <Headset size={14} /> : <MicOff size={14} />} {driver.isHumanMode ? 'Human Agent Mode' : 'Automation Active'}
                    </button>
               </div>
              <button onClick={onClose} className="p-2 hover:bg-gray-800 rounded-full transition-colors"><X size={20} /></button>
            </div>
          </div>

          <div className="flex-1 flex overflow-hidden">
            <div className="flex-1 flex flex-col border-r border-gray-200 min-w-[400px] relative">
              <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4 bg-gray-50 space-y-4">
                {messages.length >= 50 && <div className="flex justify-center"><button onClick={handleLoadMore} disabled={loadingHistory} className="text-xs bg-white border border-gray-300 rounded-full px-4 py-2">Load Previous</button></div>}
                {messages.map((msg) => (
                    <div key={msg.id} className={`flex ${msg.sender === 'driver' ? 'justify-start' : 'justify-end'}`}>
                        <div className={`max-w-[80%] rounded-2xl shadow-sm overflow-hidden ${msg.sender === 'driver' ? 'bg-white text-gray-900 rounded-tl-none border border-gray-200' : 'bg-blue-600 text-white rounded-tr-none'}`}>
                            {(msg.headerImageUrl || msg.imageUrl) && (<div className="w-full aspect-video overflow-hidden bg-black/5 relative"><img src={msg.headerImageUrl || msg.imageUrl} className="w-full h-full object-cover" /></div>)}
                            <div className="px-4 py-3">
                                {msg.templateName && <div className="text-[10px] uppercase font-bold opacity-50 mb-1 flex items-center gap-1"><LayoutTemplate size={10} /> Template: {msg.templateName}</div>}
                                {msg.text && <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.text}</p>}
                                <div className="text-[10px] mt-1 text-right opacity-60">{new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</div>
                            </div>
                        </div>
                    </div>
                ))}
                
                {scheduledMessages.length > 0 && (
                    <div className="space-y-4 pt-4 border-t border-gray-200 mt-4">
                        <div className="flex justify-center"><span className="text-xs font-bold text-gray-400 uppercase tracking-wider bg-gray-100 px-3 py-1 rounded-full">Scheduled Queue</span></div>
                        {scheduledMessages.map(msg => (
                            <div key={msg.id} className="flex justify-end opacity-90">
                                <div className={`max-w-[80%] rounded-2xl rounded-tr-none border-2 border-dashed p-4 relative group ${
                                    msg.status === 'failed' ? 'border-red-300 bg-red-50' : 
                                    msg.status === 'sent' ? 'border-green-300 bg-green-50' :
                                    msg.status === 'processing' ? 'border-blue-300 bg-blue-50' :
                                    'border-amber-300 bg-amber-50'
                                }`}>
                                    <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity bg-white rounded p-1 shadow-sm z-10">
                                        {msg.status !== 'sent' && <button onClick={() => handleSendNowScheduled(msg.id)} className="p-1 text-green-600" title="Send Now"><Zap size={14}/></button>}
                                        {msg.status !== 'sent' && <button onClick={() => openEditModal(msg)} className="p-1 text-blue-600" title="Edit"><Edit2 size={14}/></button>}
                                        <button onClick={() => handleCancelScheduled(msg.id)} className="p-1 text-red-600" title="Delete"><Trash2 size={14}/></button>
                                    </div>
                                    <div className={`flex items-center gap-2 mb-2 text-xs font-bold ${
                                        msg.status === 'failed' ? 'text-red-700' : 
                                        msg.status === 'sent' ? 'text-green-700' :
                                        'text-amber-700'
                                    }`}>
                                        <Clock size={12} /> {new Date(msg.scheduledTime).toLocaleString()}
                                        <span className="uppercase bg-white/50 px-1 rounded ml-auto">{msg.status}</span>
                                    </div>
                                    <p className="text-sm text-gray-700 italic">{msg.payload.text || '[Media Only]'}</p>
                                    {msg.status === 'failed' && <p className="text-xs text-red-600 mt-2 flex items-center gap-1 font-bold"><AlertTriangle size={12} /> Delivery Failed</p>}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className="p-4 bg-white border-t border-gray-200 relative">
                {showSchedule && (
                    <div className="absolute bottom-[calc(100%+10px)] left-4 right-4 bg-white rounded-xl shadow-2xl border border-gray-200 p-4 z-20">
                        <div className="flex justify-between mb-2"><h4 className="font-bold text-gray-800">Schedule</h4><button onClick={() => setShowSchedule(false)}><X size={16} /></button></div>
                        <input type="datetime-local" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
                    </div>
                )}
                <div className="flex gap-2 mb-3">
                    <button onClick={() => setShowMediaPicker(true)} className="px-3 py-1.5 rounded-full text-xs font-bold border border-gray-200 flex items-center gap-1 hover:bg-gray-50"><Paperclip size={12} /> Attach</button>
                    <button onClick={() => setIsTemplateMode(!isTemplateMode)} className={`px-3 py-1.5 rounded-full text-xs font-bold border flex items-center gap-1 ${isTemplateMode ? 'bg-purple-100 text-purple-700 border-purple-200' : 'border-gray-200 hover:bg-gray-50'}`}><LayoutTemplate size={12} /> Template</button>
                    <button onClick={() => setShowSchedule(!showSchedule)} className={`px-3 py-1.5 rounded-full text-xs font-bold border flex items-center gap-1 ${showSchedule ? 'bg-amber-100 text-amber-700 border-amber-200' : 'border-gray-200 hover:bg-gray-50'}`}><Clock size={12} /> Schedule</button>
                </div>
                <div className="flex gap-3">
                  <textarea value={replyText} onChange={(e) => setReplyText(e.target.value)} onKeyDown={handleKeyPress} placeholder={isTemplateMode ? "Body Parameter..." : "Type a message..."} className="flex-1 resize-none border border-gray-300 rounded-xl p-3 focus:outline-none focus:ring-2 focus:ring-blue-500 h-20 shadow-inner" />
                  <button onClick={handleSend} disabled={(!replyText.trim() && !templateName && !selectedMedia)} className="self-end p-3 rounded-xl bg-black text-white hover:bg-gray-800 w-12 h-12 flex items-center justify-center disabled:opacity-50"><Send size={20} /></button>
                </div>
              </div>
            </div>

            <div className="w-[450px] bg-white border-l border-gray-200 p-6">
                <h3 className="text-xs font-bold text-gray-500 uppercase mb-3">Documents</h3>
                {filteredDocuments.length === 0 ? (
                    <div className="text-center p-6 border-2 border-dashed border-gray-100 rounded-xl bg-gray-50">
                        <FileText size={24} className="mx-auto text-gray-300 mb-2" />
                        <p className="text-xs text-gray-400">No documents uploaded yet.</p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {filteredDocuments.map(doc => (
                            <div key={doc.id} className="bg-white p-3 rounded-xl border border-gray-200 shadow-sm flex justify-between items-center group hover:border-blue-200 transition-colors">
                                <div className="flex items-center gap-2">
                                    <div className="bg-blue-50 p-2 rounded-lg text-blue-600"><FileText size={16} /></div>
                                    <div className="flex flex-col">
                                        <span className="text-xs font-bold capitalize text-gray-800">{doc.docType.replace('_', ' ')}</span>
                                        <span className="text-[9px] text-gray-400">{new Date(doc.timestamp).toLocaleDateString()}</span>
                                    </div>
                                </div>
                                <span className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase ${doc.verificationStatus === 'approved' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>{doc.verificationStatus}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
          </div>
        </div>
      </div>
      
      {editingMessage && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
              <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6 space-y-4">
                  <h3 className="font-bold">Edit Message</h3>
                  <input type="datetime-local" value={editTime} onChange={(e) => setEditTime(e.target.value)} className="w-full p-2 border rounded" />
                  <textarea value={editText} onChange={(e) => setEditText(e.target.value)} className="w-full p-2 border rounded h-24" />
                  <div className="flex gap-2"><button onClick={() => setEditingMessage(null)} className="flex-1 py-2 border rounded">Cancel</button><button onClick={saveEditedMessage} className="flex-1 py-2 bg-blue-600 text-white rounded">Save</button></div>
              </div>
          </div>
      )}
      <MediaSelectorModal isOpen={showMediaPicker} onClose={() => setShowMediaPicker(false)} onSelect={(url, type) => { setSelectedMedia({ url, type }); setShowMediaPicker(false); }} allowedType="All" />
    </div>
  );
};
