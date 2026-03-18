
import React, { useState, useEffect, useRef } from 'react';
import { Driver, Message, ScheduledMessage, DriverDocument } from '../types';
import { 
  X, Send, Headset, MicOff, Clock, Paperclip, Edit2, Trash2, Zap, FileText, Download, Loader2, CalendarClock, Save, AlertTriangle, History, MessageCircle, ShieldAlert, User, Bot, Mic, Video, CheckCircle
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

export const ChatDrawer: React.FC<ChatDrawerProps> = ({ driver, onClose, onSendMessage, onUpdateDriver, updateConnectionState = 'disconnected' }) => {
  const [replyText, setReplyText] = useState('');
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleTime, setScheduleTime] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isHumanModeLoading, setIsHumanModeLoading] = useState(false);
  
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
    if (!driver || isHumanModeLoading) return;
    
    const newMode = !driver.isHumanMode;
    setIsHumanModeLoading(true);
    try {
      await liveApiService.updateDriver(driver.id, { isHumanMode: newMode });
      
      // Predefined messages
      if (newMode) {
        // Entering Human Mode
        await liveApiService.sendMessage(driver.id, `Hi, I am an agent, how may I help you?`);
      } else {
        // Exiting Human Mode
        await liveApiService.sendMessage(driver.id, `Chatbot resumed. I'm back online.`);
      }

      // Update parent state
      onUpdateDriver(driver.id, { isHumanMode: newMode });
      
      // Refresh messages locally
      const messages = await liveApiService.getDriverMessages(driver.id);
      setLocalMessages(messages);
    } catch (err) {
      console.error('Failed to toggle human mode:', err);
      alert('Failed to toggle human mode');
    } finally {
      setIsHumanModeLoading(false);
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
      if (type === 'video') return <div className="w-full aspect-video bg-black rounded mb-2"><video src={url} controls className="w-full h-full object-contain" /></div>;
      if (type === 'audio') return <div className="w-full bg-gray-100 rounded mb-2 p-2"><audio src={url} controls className="w-full" /></div>;
      if (type === 'document') return <div className="w-full rounded mb-2 p-3 border border-gray-200 bg-gray-50 text-xs text-gray-600">Document attached</div>;
      return <div className="w-full aspect-video bg-gray-100 rounded mb-2"><img src={url} className="w-full h-full object-cover rounded" alt="media" /></div>;
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
          
          <div className="bg-black text-white px-6 py-4 flex items-center justify-between shadow-md z-10">
            <div className="flex items-center gap-4">
               <div className="h-10 w-10 bg-gray-800 rounded-full flex items-center justify-center text-lg font-bold">{driver.name.charAt(0)}</div>
               <div>
                 <div className="flex items-center gap-2">
                    <h2 className="text-xl font-semibold">{driver.name}</h2>
                    <MetaWindowTimer lastMessageTime={driver.lastMessageTime} />
                 </div>
                 <div className="flex items-center gap-2">
                   <p className="text-gray-400 text-sm font-mono">{driver.phoneNumber}</p>
                   <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full ${updateConnectionState === 'connected' ? 'bg-green-600/30 text-green-200' : 'bg-amber-500/30 text-amber-100'}`}>
                     {updateConnectionState === 'connected' ? 'Push Live' : updateConnectionState}
                   </span>
                 </div>
               </div>
            </div>
            <div className="flex items-center gap-4">
               <div className="flex items-center gap-2 bg-gray-900 rounded-lg p-1 border border-gray-800">
                    <button 
                      type="button" 
                      onClick={handleToggleHumanMode} 
                      disabled={isHumanModeLoading}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-bold transition-all ${driver.isHumanMode ? 'bg-amber-500 text-black' : 'text-gray-400 hover:text-white'}`}
                    >
                        {isHumanModeLoading ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : driver.isHumanMode ? (
                          <User size={14} />
                        ) : (
                          <Bot size={14} />
                        )}
                        {driver.isHumanMode ? 'Human Mode ON' : 'Bot Active'}
                    </button>
               </div>
              <button type="button" onClick={onClose} className="p-2 hover:bg-gray-800 rounded-full transition-colors"><X size={20} /></button>
            </div>
          </div>

          <div className="flex-1 flex overflow-hidden">
            <div className="flex-1 flex flex-col border-r border-gray-200 min-w-[400px] relative">
              <div className="flex-1 overflow-y-auto p-4 bg-gray-50 space-y-4">
                {localMessages.map((msg) => {
                    const media = getMessageMedia(msg);
                    return msg.type === 'system_error' ? (
                        <div key={msg.id} className="flex justify-center my-4 animate-pulse">
                            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg flex items-center gap-2 text-sm max-w-[90%] shadow-sm">
                                <AlertTriangle size={18} />
                                <span className="font-bold">SYSTEM ERROR:</span>
                                <span>{msg.text}</span>
                            </div>
                        </div>
                    ) : (
                        <div key={msg.id} className={`flex ${msg.sender === 'driver' ? 'justify-start' : 'justify-end'}`}>
                            <div className={`max-w-[80%] rounded-2xl shadow-sm overflow-hidden ${
                              msg.senderType === 'driver' 
                                ? 'bg-white text-gray-900 rounded-tl-none border border-gray-200' 
                                : msg.senderType === 'bot'
                                ? 'bg-black text-white rounded-tr-none'
                                : 'bg-emerald-500 text-white rounded-tr-none'
                            }`}>
                                {/* Media Rendering */}
                                {media.url && (
                                  <div className="p-1">
                                    {media.type === 'video' ? (
                                      <div className="rounded-xl overflow-hidden bg-black/10">
                                        <video src={media.url} controls className="w-full h-auto block" />
                                      </div>
                                    ) : media.type === 'audio' ? (
                                      <div className={`flex items-center gap-3 p-3 rounded-xl ${msg.senderType === 'driver' ? 'bg-gray-100' : msg.senderType === 'bot' ? 'bg-gray-800' : 'bg-emerald-600'}`}>
                                        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${msg.senderType === 'driver' ? 'bg-gray-200 text-gray-500' : msg.senderType === 'bot' ? 'bg-gray-900 text-white' : 'bg-emerald-700 text-white'}`}>
                                          <Mic size={18} />
                                        </div>
                                        <audio src={media.url} controls className="h-8 w-48" />
                                      </div>
                                    ) : media.type === 'document' ? (
                                      <a href={media.url} target="_blank" rel="noopener noreferrer" className={`flex items-center gap-3 p-3 rounded-xl transition-colors ${
                                        msg.senderType === 'driver' ? 'bg-gray-50 hover:bg-gray-100' : msg.senderType === 'bot' ? 'bg-gray-800 hover:bg-gray-900' : 'bg-emerald-600 hover:bg-emerald-700'
                                      }`}>
                                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${msg.senderType === 'driver' ? 'bg-gray-100 text-gray-500' : msg.senderType === 'bot' ? 'bg-gray-900 text-white' : 'bg-emerald-700 text-white'}`}>
                                          <FileText size={20} />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                          <p className="text-xs font-bold truncate">Document</p>
                                          <p className="text-[10px] opacity-70">Click to view</p>
                                        </div>
                                      </a>
                                    ) : (
                                      <div className="rounded-xl overflow-hidden border border-black/5">
                                        <img src={media.url} className="w-full h-auto block" alt="media" referrerPolicy="no-referrer" />
                                      </div>
                                    )}
                                  </div>
                                )}

                                <div className="px-4 py-2">
                                    {renderMessageText(msg.text)}
                                    <div className={`text-[10px] mt-1 text-right flex justify-end gap-1 items-center ${msg.senderType === 'driver' ? 'text-gray-400' : msg.senderType === 'bot' ? 'text-gray-400' : 'text-emerald-100'}`}>
                                        {msg.status === 'sending' && <Clock size={10} className="animate-spin" />}
                                        {new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                                        {msg.senderType !== 'driver' && (
                                          <div className="flex">
                                            <CheckCircle size={10} className={msg.status === 'read' ? (msg.senderType === 'bot' ? 'text-blue-400' : 'text-blue-200') : ''} />
                                          </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                })}
                
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

              <div className="p-4 bg-white border-t border-gray-200 relative">
                {!isWindowActive ? (
                  <div className="flex flex-col items-center justify-center py-8 px-4 bg-gray-50 rounded-2xl border border-dashed border-gray-300 animate-in fade-in zoom-in duration-300">
                    <div className="w-12 h-12 bg-gray-200 rounded-full flex items-center justify-center mb-3 text-gray-500">
                      <History size={24} />
                    </div>
                    <h4 className="text-sm font-bold text-gray-900 mb-1">Chat History Mode</h4>
                    <p className="text-xs text-gray-500 text-center max-w-xs leading-relaxed">
                      The 24-hour Meta response window has expired. You can only view the history until the customer sends a new message.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {selectedMedia && (
                        <div className="flex items-center justify-between p-2 bg-blue-50 rounded-xl border border-blue-100 animate-in slide-in-from-bottom-2">
                            <div className="flex items-center gap-2">
                                <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center text-blue-600 border border-blue-200">
                                    {selectedMedia.type === 'image' ? <Paperclip size={18} /> : 
                                     selectedMedia.type === 'video' ? <Video size={18} /> : 
                                     selectedMedia.type === 'audio' ? <Mic size={18} /> : 
                                     <FileText size={18} />}
                                </div>
                                <div className="flex flex-col">
                                    <span className="text-[10px] font-bold text-blue-700 uppercase tracking-wider">{selectedMedia.type} Selected</span>
                                    <span className="text-[8px] text-blue-500">Ready to send</span>
                                </div>
                            </div>
                            <button type="button" onClick={() => setSelectedMedia(null)} className="text-blue-700 hover:bg-blue-100 p-1 rounded-full transition-colors"><X size={14} /></button>
                        </div>
                    )}
                    {showSchedule && (
                        <div className="absolute bottom-[calc(100%+10px)] left-4 right-4 bg-white rounded-xl shadow-2xl border border-gray-200 p-4 z-20 animate-in slide-in-from-bottom-2">
                            <div className="flex justify-between mb-2"><h4 className="font-bold text-gray-800">Schedule Message</h4><button type="button" onClick={() => setShowSchedule(false)}><X size={16} /></button></div>
                            <input type="datetime-local" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
                        </div>
                    )}
                    <div className="flex items-center gap-2 bg-gray-100 p-1 rounded-3xl">
                        <button 
                          type="button" 
                          onClick={() => setShowMediaPicker(true)} 
                          disabled={isSending} 
                          className={`w-10 h-10 flex items-center justify-center rounded-full transition-all ${selectedMedia ? 'bg-blue-100 text-blue-700' : 'text-gray-500 hover:text-blue-600 hover:bg-white'}`}
                        >
                          <Paperclip size={20} />
                        </button>
                        <button 
                          type="button" 
                          onClick={() => setShowSchedule(!showSchedule)} 
                          disabled={isSending} 
                          className={`w-10 h-10 flex items-center justify-center rounded-full transition-all ${showSchedule ? 'bg-amber-100 text-amber-700' : 'text-gray-500 hover:text-amber-600 hover:bg-white'}`}
                        >
                          <Clock size={20} />
                        </button>
                        <textarea 
                          value={replyText} 
                          onChange={(e) => setReplyText(e.target.value)} 
                          placeholder="Type a message..." 
                          className="flex-1 bg-transparent border-none rounded-2xl text-sm p-2.5 focus:ring-0 resize-none h-10 max-h-32 custom-scrollbar" 
                          disabled={isSending} 
                          onKeyDown={e => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              handleSend();
                            }
                          }}
                        />
                        <button 
                          type="button" 
                          onClick={handleSend} 
                          disabled={(!replyText.trim() && !selectedMedia) || isSending} 
                          className="w-10 h-10 bg-emerald-500 text-white rounded-full flex items-center justify-center disabled:opacity-50 active:scale-95 transition-all shadow-lg shadow-emerald-200"
                        >
                          {isSending ? <Loader2 size={20} className="animate-spin" /> : <Send size={20} />}
                        </button>
                    </div>
                  </div>
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
