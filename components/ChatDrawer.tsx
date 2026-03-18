
import React, { useState, useEffect, useRef } from 'react';
import { Driver, Message, ScheduledMessage, DriverDocument, BotSettings } from '../types';
import { 
  X, Send, Headset, MicOff, Clock, Paperclip, Edit2, Trash2, Zap, FileText, Download, Loader2, CalendarClock, Save, AlertTriangle, History, MessageCircle, ShieldAlert, Check, CheckCheck, Smile, MoreVertical, Phone, Video, ArrowLeft
} from 'lucide-react';
import { liveApiService, UpdateConnectionState } from '../services/liveApiService';
import { reportUiFailure, reportUiRecovery } from '../services/uiFailureMonitor';
import { MediaSelectorModal } from './MediaSelectorModal.tsx';

interface ChatDrawerProps {
  driver: Driver | null;
  onClose: () => void;
  onSendMessage: (text: string) => void;
  onUpdateDriver: (id: string, updates: Partial<Driver>) => void;
  updateConnectionState?: UpdateConnectionState;
  userName?: string;
  botSettings?: BotSettings | null;
}

const MetaWindowTimer: React.FC<{ lastMessageTime: number }> = ({ lastMessageTime }) => {
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const WINDOW_DURATION = 24 * 60 * 60 * 1000; // 24 hours

  useEffect(() => {
    const calculateTime = () => {
      const now = Date.now();
      const diff = (lastMessageTime + WINDOW_DURATION) - now;
      setTimeLeft(Math.max(0, diff));
    };

    calculateTime();
    const timer = setInterval(calculateTime, 1000);
    return () => clearInterval(timer);
  }, [lastMessageTime]);

  if (timeLeft === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-red-50 text-red-600 rounded-full text-[10px] font-bold uppercase tracking-wider border border-red-100">
        <ShieldAlert size={12} />
        Window Expired (History Mode)
      </div>
    );
  }

  const hours = Math.floor(timeLeft / (60 * 60 * 1000));
  const minutes = Math.floor((timeLeft % (60 * 60 * 1000)) / (60 * 1000));
  const seconds = Math.floor((timeLeft % (60 * 1000)) / 1000);

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-50 text-emerald-600 rounded-full text-[10px] font-bold uppercase tracking-wider border border-emerald-100">
      <Clock size={12} className="animate-pulse" />
      {hours}h {minutes}m {seconds}s remaining
    </div>
  );
};

export const ChatDrawer: React.FC<ChatDrawerProps> = ({ driver, onClose, onSendMessage, onUpdateDriver, updateConnectionState = 'disconnected', userName, botSettings }) => {
  const [replyText, setReplyText] = useState('');
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleTime, setScheduleTime] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  
  const [showMediaPicker, setShowMediaPicker] = useState(false);
  const [selectedMedia, setSelectedMedia] = useState<{url: string, type: 'image' | 'video' | 'document' | 'audio'} | null>(null);

  const [documents, setDocuments] = useState<DriverDocument[]>([]);
  const [scheduledMessages, setScheduledMessages] = useState<ScheduledMessage[]>([]);
  const [localMessages, setLocalMessages] = useState<Message[]>([]);
  
  // EDIT STATE
  const [editingMessage, setEditingMessage] = useState<ScheduledMessage | null>(null);
  const [editTime, setEditTime] = useState('');
  const [editText, setEditText] = useState('');

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const isWindowActive = driver ? (Date.now() - driver.lastMessageTime < 24 * 60 * 60 * 1000) : false;

  useEffect(() => {
    if (driver) {
        setLocalMessages(driver.messages || []);
        loadDocuments(driver.id);
        loadScheduledMessages(driver.id);
    }
  }, [driver]);

  useEffect(() => {
      if (!driver) return;

      const unsubscribe = liveApiService.subscribeToUpdates(() => {}, {
          driverId: driver.id,
          pollIntervalMs: 12000,
          onMessages: (latestMsgs) => {
              setLocalMessages(prev => {
                  if (latestMsgs.length === 0) return prev;
                  const newLastId = latestMsgs[latestMsgs.length - 1].id;
                  const prevLastId = prev.length > 0 ? prev[prev.length - 1].id : '';
                  if (latestMsgs.length !== prev.length || newLastId !== prevLastId) return latestMsgs;
                  return prev;
              });
          },
          onScheduledMessages: (latestSched) => {
              setScheduledMessages(latestSched);
          }
      });

      return () => unsubscribe();
  }, [driver?.id]);

  useEffect(() => {
    if (messagesEndRef.current) messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [localMessages.length, scheduledMessages.length]);

  const loadDocuments = async (driverId: string) => {
      try { 
          const docs = await liveApiService.getDriverDocuments(driverId); 
          setDocuments(docs || []); 
          reportUiRecovery('polling', `/api/drivers/${driverId}/documents`);
      } catch(e) {
          const streak = reportUiFailure({
            channel: 'polling',
            endpoint: `/api/drivers/${driverId}/documents`,
            error: e,
            notifyAdmin: (message) => console.warn('[admin.notify]', message)
          });
          if (streak === 1) {
            alert('Documents are temporarily unavailable.');
          }
          setDocuments([]);
      }
  };

  const loadScheduledMessages = async (driverId: string) => {
      try {
          const items = await liveApiService.getScheduledMessages(driverId);
          setScheduledMessages(items);
          reportUiRecovery('polling', `/api/drivers/${driverId}/scheduled-messages`);
      } catch(e) {
          const streak = reportUiFailure({
            channel: 'polling',
            endpoint: `/api/drivers/${driverId}/scheduled-messages`,
            error: e,
            notifyAdmin: (message) => console.warn('[admin.notify]', message)
          });
          if (streak === 1) {
            alert('Scheduled message sync is degraded.');
          }
      }
  };

  const handleCancelScheduled = async (msgId: string) => {
      if(!window.confirm("Delete this scheduled message?")) return;
      try { await liveApiService.cancelScheduledMessage(msgId); setScheduledMessages(prev => prev.filter(m => m.id !== msgId)); } catch (e: any) { console.error(`Error: ${e.message}`); }
  };

  const handleSendNowScheduled = async (msgId: string) => {
      try { 
          await liveApiService.updateScheduledMessage(msgId, { scheduledTime: Date.now() }); 
          if(driver) loadScheduledMessages(driver.id); 
      } catch (e: any) { console.error(`Error: ${e.message}`); }
  };

  const openEditModal = (msg: ScheduledMessage) => {
      setEditingMessage(msg);
      let txt = '';
      if(msg.payload) {
          if (typeof msg.payload === 'string') txt = msg.payload;
          else if (typeof msg.payload.text === 'string') txt = msg.payload.text;
      }
      setEditText(txt);
      
      // Convert timestamp to local datetime-local format
      const date = new Date(msg.scheduledTime);
      const tzOffset = date.getTimezoneOffset() * 60000;
      const localISOTime = new Date(date.getTime() - tzOffset).toISOString().slice(0, 16);
      setEditTime(localISOTime);
  };

  const saveEditedMessage = async () => {
      if (!editingMessage || !editTime) return;
      const newTime = new Date(editTime).getTime();
      
      if (newTime <= Date.now()) { 
          alert("Scheduled time must be in the future."); 
          return; 
      }
      
      try { 
          await liveApiService.updateScheduledMessage(editingMessage.id, { text: editText, scheduledTime: newTime }); 
          setEditingMessage(null); 
          if (driver) loadScheduledMessages(driver.id); 
      } catch(e: any) { 
          alert(`Update failed: ${e.message}`); 
      }
  };

  const handleToggleHumanMode = async () => {
    if (!driver) return;
    const newMode = !driver.isHumanMode;
    onUpdateDriver(driver.id, { isHumanMode: newMode });
    
    // Send predefined message
    const firstName = userName?.split(' ')[0] || 'Admin';
    let message = '';
    
    if (newMode) {
      const template = botSettings?.humanModeEntryMessage || "Hi, I am {{name}}, how may I help you?";
      message = template.replace(/\{\{name\}\}/g, firstName);
    } else {
      message = botSettings?.botModeTransitionMessage || "our Staff will get back to you shortly";
    }
    
    try {
      await onSendMessage(message);
    } catch (e) {
      console.error("Failed to send mode change message", e);
    }
  };

  if (!driver) return null;

  const handleSend = async (e?: React.MouseEvent | React.FormEvent) => {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }

    if (!replyText.trim() && !selectedMedia) return;
    setIsSending(true);

    try {
        if (showSchedule && scheduleTime) {
            if (new Date(scheduleTime).getTime() <= Date.now()) { throw new Error("Select a time in the future."); }
            
            await liveApiService.scheduleMessage(
                [driver.id], 
                { 
                    text: replyText, 
                    mediaUrl: selectedMedia?.url, 
                    mediaType: selectedMedia?.type 
                }, 
                new Date(scheduleTime).getTime()
            ); 
            setShowSchedule(false); setScheduleTime('');
            await loadScheduledMessages(driver.id); 
        } else if (selectedMedia) {
            await liveApiService.sendMessage(driver.id, replyText, { mediaUrl: selectedMedia.url, mediaType: selectedMedia.type }); 
        } else {
            await onSendMessage(replyText);
        }
        setReplyText('');
        setSelectedMedia(null);
    } catch(e: any) {
        alert(`Failed: ${e.message}`);
    } finally {
        setIsSending(false);
    }
  };

  const renderMessageText = (rawText: any) => {
      if (!rawText) return null;
      if (typeof rawText !== 'string') return null; 
      try {
          if (rawText.trim().startsWith('{')) {
              const parsed = JSON.parse(rawText);
              if (parsed.caption) return <p className="text-sm leading-relaxed whitespace-pre-wrap">{parsed.caption}</p>;
              return null; 
          }
      } catch (e) {
          reportUiFailure({
            channel: 'ui',
            endpoint: 'parser://message-json-caption',
            error: e
          });
      }
      return <p className="text-sm leading-relaxed whitespace-pre-wrap">{rawText}</p>;
  };

  const renderMediaPreview = (url?: string, type?: string) => {
      if (!url) return null;
      
      if (type === 'video') {
          return (
              <div className="w-full aspect-video bg-black rounded-t-lg relative group">
                  <video src={url} className="w-full h-full object-contain" />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/40 transition-all">
                      <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center text-white border border-white/30">
                          <Video size={24} />
                      </div>
                  </div>
                  <div className="absolute bottom-2 right-2 px-1.5 py-0.5 bg-black/60 rounded text-[10px] text-white font-bold flex items-center gap-1">
                      <Video size={10} /> VIDEO
                  </div>
              </div>
          );
      }
      
      if (type === 'audio') {
          return (
              <div className="w-full bg-[#f0f0f0]/50 p-3 rounded-t-lg flex items-center gap-3 border-b border-gray-100">
                  <div className="w-10 h-10 rounded-full bg-emerald-500 flex items-center justify-center text-white shadow-sm">
                      <Headset size={20} />
                  </div>
                  <div className="flex-1">
                      <audio src={url} controls className="w-full h-8 custom-audio-player" />
                  </div>
              </div>
          );
      }
      
      if (type === 'document') {
          const fileName = url.split('/').pop() || 'Document';
          return (
              <a 
                  href={url} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="w-full p-3 rounded-t-lg bg-gray-50 flex items-center gap-3 border-b border-gray-100 hover:bg-gray-100 transition-colors group"
              >
                  <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600 group-hover:bg-blue-600 group-hover:text-white transition-all">
                      <FileText size={20} />
                  </div>
                  <div className="flex-1 min-w-0">
                      <p className="text-xs font-bold text-gray-900 truncate">{fileName}</p>
                      <p className="text-[10px] text-gray-400 uppercase font-bold">PDF • 1.2 MB</p>
                  </div>
                  <Download size={16} className="text-gray-400" />
              </a>
          );
      }
      
      return (
          <div className="w-full aspect-square bg-gray-100 rounded-t-lg overflow-hidden relative group">
              <img src={url} className="w-full h-full object-cover transition-transform group-hover:scale-105" alt="media" referrerPolicy="no-referrer" />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-all" />
          </div>
      );
  };

  const getMessageMedia = (msg: Message): { url?: string; type?: string } => {
      if (msg.audioUrl) return { url: msg.audioUrl, type: 'audio' };
      if (msg.videoUrl) return { url: msg.videoUrl, type: 'video' };
      if (msg.documentUrl) return { url: msg.documentUrl, type: 'document' };
      if (msg.imageUrl) return { url: msg.imageUrl, type: 'image' };
      return {};
  };

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm transition-opacity" onClick={onClose} />
      <div className="absolute inset-y-0 right-0 flex max-w-full pl-10 pointer-events-none">
        <div className="pointer-events-auto w-screen max-w-5xl bg-white shadow-2xl flex flex-col h-full">
          
          <div className="bg-[#075e54] text-white px-4 py-3 flex items-center justify-between shadow-md z-10">
            <div className="flex items-center gap-3">
               <button onClick={onClose} className="p-1 hover:bg-white/10 rounded-full transition-colors"><ArrowLeft size={20} /></button>
               <div className="h-10 w-10 bg-gray-200 rounded-full flex items-center justify-center text-lg font-bold text-gray-600 overflow-hidden">
                 {driver.name.charAt(0)}
               </div>
               <div className="flex-1 min-w-0">
                 <div className="flex items-center gap-2">
                    <h2 className="text-base font-semibold truncate">{driver.name}</h2>
                    <MetaWindowTimer lastMessageTime={driver.lastMessageTime} />
                 </div>
                 <div className="flex items-center gap-2">
                   <p className="text-white/70 text-xs truncate">{driver.phoneNumber}</p>
                   <span className={`text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded-sm font-bold ${updateConnectionState === 'connected' ? 'bg-emerald-500/30 text-emerald-100' : 'bg-amber-500/30 text-amber-100'}`}>
                     {updateConnectionState === 'connected' ? 'Online' : updateConnectionState}
                   </span>
                 </div>
               </div>
            </div>
            <div className="flex items-center gap-3">
               <div className="flex items-center gap-1">
                    <button 
                        type="button" 
                        onClick={handleToggleHumanMode} 
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] font-bold transition-all border shadow-sm ${driver.isHumanMode ? 'bg-white text-[#075e54] border-white' : 'bg-transparent text-white border-white/30 hover:bg-white/10'}`}
                    >
                        {driver.isHumanMode ? <Headset size={12} className="animate-pulse" /> : <MicOff size={12} />} 
                        {driver.isHumanMode ? 'Human Mode' : 'Bot Mode'}
                    </button>
               </div>
               <div className="flex items-center gap-1 text-white/80">
                 <button className="p-2 hover:bg-white/10 rounded-full"><Video size={20} /></button>
                 <button className="p-2 hover:bg-white/10 rounded-full"><Phone size={18} /></button>
                 <button className="p-2 hover:bg-white/10 rounded-full"><MoreVertical size={20} /></button>
               </div>
            </div>
          </div>

          <div className="flex-1 flex overflow-hidden">
            <div className="flex-1 flex flex-col border-r border-gray-200 min-w-[400px] relative">
              <div className="flex-1 overflow-y-auto p-4 space-y-2 relative" style={{ backgroundColor: '#e5ddd5', backgroundImage: 'url("https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png")', backgroundRepeat: 'repeat', backgroundSize: '400px' }}>
                {localMessages.map((msg, idx) => {
                    const media = getMessageMedia(msg);
                    const isOutgoing = msg.sender !== 'driver';
                    const showTail = idx === 0 || localMessages[idx-1].sender !== msg.sender;
                    
                    return msg.type === 'system_error' ? (
                        <div key={msg.id} className="flex justify-center my-4">
                            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg flex items-center gap-2 text-xs max-w-[90%] shadow-sm">
                                <AlertTriangle size={14} />
                                <span className="font-bold">SYSTEM ERROR:</span>
                                <span>{msg.text}</span>
                            </div>
                        </div>
                    ) : (
                        <div key={msg.id} className={`flex ${isOutgoing ? 'justify-end' : 'justify-start'} mb-1 px-2`}>
                            <div className={`max-w-[85%] rounded-lg shadow-sm overflow-hidden relative ${isOutgoing ? 'bg-[#dcf8c6] text-gray-900' : 'bg-white text-gray-900'} ${showTail ? (isOutgoing ? 'rounded-tr-none' : 'rounded-tl-none') : ''}`}>
                                {showTail && (
                                    <div className={`absolute top-0 w-2 h-2 ${isOutgoing ? '-right-1 bg-[#dcf8c6]' : '-left-1 bg-white'}`} style={{ clipPath: isOutgoing ? 'polygon(0 0, 0 100%, 100% 0)' : 'polygon(100% 0, 100% 100%, 0 0)' }}></div>
                                )}
                                {renderMediaPreview(media.url, media.type)}
                                <div className="px-2 pt-1 pb-1 flex flex-col">
                                    <div className="pr-16">
                                        {renderMessageText(msg.text)}
                                    </div>
                                    <div className="text-[9px] mt-0.5 self-end opacity-50 flex items-center gap-1">
                                        {new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                                        {isOutgoing && (
                                            msg.status === 'sending' ? <Clock size={10} className="animate-spin" /> : 
                                            msg.status === 'read' ? <CheckCheck size={12} className="text-blue-500" /> :
                                            <CheckCheck size={12} />
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                })}
                
                {isTyping && (
                    <div className="flex justify-start mb-1 px-2">
                        <div className="bg-white text-gray-500 px-3 py-2 rounded-lg rounded-tl-none shadow-sm text-xs italic flex items-center gap-2">
                            <div className="flex gap-1">
                                <div className="w-1 h-1 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                <div className="w-1 h-1 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                <div className="w-1 h-1 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                            </div>
                            Typing...
                        </div>
                    </div>
                )}
                
                {scheduledMessages.length > 0 && (
                    <div className="flex flex-col gap-4 mt-6">
                        <div className="flex items-center gap-2 justify-center opacity-50">
                            <div className="h-px bg-gray-300 w-12"></div>
                            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1"><CalendarClock size={12}/> Scheduled Queue</span>
                            <div className="h-px bg-gray-300 w-12"></div>
                        </div>
                        {scheduledMessages.map(msg => (
                            <div key={msg.id} className="flex justify-end animate-in slide-in-from-bottom-2">
                                <div className="max-w-[85%] bg-amber-50 border-2 border-dashed border-amber-300 rounded-2xl rounded-tr-none p-1 relative group transition-all hover:bg-amber-100/50">
                                    <div className="flex items-center justify-between px-3 py-2 border-b border-amber-200/50 mb-2">
                                        <div className="flex items-center gap-1.5 text-xs font-bold text-amber-700">
                                            <Clock size={12} /> {new Date(msg.scheduledTime).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'})}
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <button type="button" onClick={() => handleSendNowScheduled(msg.id)} className="p-1.5 bg-green-100 text-green-700 rounded hover:bg-green-200 transition-colors" title="Send Now"><Zap size={14}/></button>
                                            <button type="button" onClick={() => openEditModal(msg)} className="p-1.5 bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors" title="Edit"><Edit2 size={14}/></button>
                                            <button type="button" onClick={() => handleCancelScheduled(msg.id)} className="p-1.5 bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors" title="Delete"><Trash2 size={14}/></button>
                                        </div>
                                    </div>
                                    <div className="px-3 pb-3">
                                        {msg.payload?.mediaUrl && renderMediaPreview(msg.payload.mediaUrl, msg.payload.mediaType)}
                                        <p className="text-sm text-gray-800 whitespace-pre-wrap">
                                            {typeof msg.payload?.text === 'string' ? msg.payload.text : ''}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className="p-2 bg-[#f0f0f0] border-t border-gray-200 relative">
                {!isWindowActive ? (
                  <div className="flex flex-col items-center justify-center py-4 px-4 bg-white/80 backdrop-blur-sm rounded-xl border border-dashed border-gray-300 mx-2 my-2">
                    <History size={20} className="text-gray-400 mb-1" />
                    <h4 className="text-xs font-bold text-gray-900">Chat History Mode</h4>
                    <p className="text-[10px] text-gray-500 text-center max-w-xs">
                      The 24-hour Meta response window has expired.
                    </p>
                  </div>
                ) : (
                  <>
                    {selectedMedia && (
                        <div className="absolute bottom-full left-0 right-0 bg-white p-3 border-t border-gray-200 flex items-center justify-between px-4 animate-in slide-in-from-bottom-2 shadow-lg">
                            <div className="flex items-center gap-3 text-xs font-bold text-gray-700">
                                <div className="w-10 h-10 bg-gray-100 rounded flex items-center justify-center text-gray-500">
                                    <Paperclip size={16} />
                                </div>
                                <div className="flex flex-col">
                                    <span className="text-gray-900">{selectedMedia.type.toUpperCase()}</span>
                                    <span className="text-[10px] text-gray-400 font-normal">Ready to send</span>
                                </div>
                            </div>
                            <button type="button" onClick={() => setSelectedMedia(null)} className="text-gray-400 hover:text-gray-600 p-1.5 rounded-full transition-colors"><X size={18} /></button>
                        </div>
                    )}
                    {showSchedule && (
                        <div className="absolute bottom-[calc(100%+10px)] left-4 right-4 bg-white rounded-xl shadow-2xl border border-gray-200 p-4 z-20 animate-in slide-in-from-bottom-2">
                            <div className="flex justify-between mb-2"><h4 className="font-bold text-gray-800">Schedule Message</h4><button type="button" onClick={() => setShowSchedule(false)}><X size={16} /></button></div>
                            <input type="datetime-local" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
                        </div>
                    )}
                    <div className="flex items-end gap-2 px-2 py-1">
                      <div className="flex-1 bg-white rounded-full flex items-center px-3 py-1 shadow-sm border border-gray-200">
                        <button type="button" onClick={() => setShowMediaPicker(true)} className="p-2 text-gray-500 hover:text-[#075e54] transition-colors"><Paperclip size={20} className="rotate-45" /></button>
                        <textarea 
                          value={replyText} 
                          onChange={(e) => setReplyText(e.target.value)} 
                          placeholder="Type a message" 
                          className="flex-1 resize-none border-none bg-transparent py-2 px-2 focus:outline-none text-sm min-h-[40px] max-h-[120px]" 
                          disabled={isSending} 
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              handleSend();
                            }
                          }}
                        />
                        <button type="button" onClick={() => setShowSchedule(!showSchedule)} className={`p-2 transition-colors ${showSchedule ? 'text-amber-500' : 'text-gray-500 hover:text-[#075e54]'}`}><Clock size={20} /></button>
                      </div>
                      <button 
                        type="button" 
                        onClick={handleSend} 
                        disabled={(!replyText.trim() && !selectedMedia) || isSending} 
                        className="p-3 rounded-full bg-[#075e54] text-white hover:bg-[#054c44] w-12 h-12 flex items-center justify-center disabled:opacity-50 shadow-md active:scale-95 transition-all"
                      >
                        {isSending ? <Loader2 size={20} className="animate-spin" /> : <Send size={20} />}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="w-[400px] bg-white border-l border-gray-200 p-6">
                <h3 className="text-xs font-bold text-gray-500 uppercase mb-3">Documents</h3>
                {documents.length === 0 ? (
                    <div className="text-center p-6 border-2 border-dashed border-gray-100 rounded-xl bg-gray-50">
                        <FileText size={24} className="mx-auto text-gray-300 mb-2" />
                        <p className="text-xs text-gray-400">No documents uploaded yet.</p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {documents.map(doc => (
                            <div key={doc.id} className="bg-white p-3 rounded-xl border border-gray-200 shadow-sm flex justify-between items-center group hover:border-blue-200 transition-colors">
                                <div className="flex items-center gap-2">
                                    <div className="bg-blue-50 p-2 rounded-lg text-blue-600"><FileText size={16} /></div>
                                    <div className="flex flex-col">
                                        <span className="text-xs font-bold capitalize text-gray-800">{doc.docType.replace('_', ' ')}</span>
                                        <span className="text-[9px] text-gray-400">{new Date(doc.timestamp).toLocaleDateString()}</span>
                                    </div>
                                </div>
                                <a href={doc.url} target="_blank" rel="noreferrer" className="text-gray-400 hover:text-blue-600 p-1"><Download size={14}/></a>
                            </div>
                        ))}
                    </div>
                )}
            </div>
          </div>
        </div>
      </div>
      
      {/* EDIT MODAL */}
      {editingMessage && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
              <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6 space-y-4 animate-in zoom-in-95">
                  <div className="flex justify-between items-center border-b border-gray-100 pb-3">
                      <h3 className="font-bold text-gray-900 flex items-center gap-2"><Edit2 size={16} className="text-blue-600" /> Edit Schedule</h3>
                      <button type="button" onClick={() => setEditingMessage(null)} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
                  </div>
                  
                  <div className="space-y-3">
                      <div>
                          <label className="text-xs font-bold text-gray-500 uppercase mb-1 block">Scheduled For</label>
                          <input type="datetime-local" value={editTime} onChange={(e) => setEditTime(e.target.value)} className="w-full p-2.5 border border-gray-200 rounded-lg text-sm bg-gray-50 focus:bg-white focus:ring-2 focus:ring-blue-500 outline-none" />
                      </div>
                      
                      <div>
                          <label className="text-xs font-bold text-gray-500 uppercase mb-1 block">Message Content</label>
                          <textarea value={editText} onChange={(e) => setEditText(e.target.value)} className="w-full p-3 border border-gray-200 rounded-lg h-32 resize-none bg-gray-50 focus:bg-white focus:ring-2 focus:ring-blue-500 outline-none text-sm" placeholder="Edit message..." />
                      </div>
                  </div>

                  <div className="flex gap-2 pt-2">
                      <button type="button" onClick={() => setEditingMessage(null)} className="flex-1 py-2.5 border border-gray-200 rounded-lg font-bold text-gray-600 hover:bg-gray-50 text-sm">Cancel</button>
                      <button type="button" onClick={saveEditedMessage} className="flex-1 py-2.5 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 text-sm flex items-center justify-center gap-2">
                          <Save size={16} /> Save Changes
                      </button>
                  </div>
              </div>
          </div>
      )}
      <MediaSelectorModal isOpen={showMediaPicker} onClose={() => setShowMediaPicker(false)} onSelect={(url, type) => { setSelectedMedia({ url, type }); setShowMediaPicker(false); }} allowedType="All" />
    </div>
  );
}
