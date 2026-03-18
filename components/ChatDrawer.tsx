
import React, { useState, useEffect, useRef } from 'react';
import { Driver, Message, ScheduledMessage, DriverDocument } from '../types';
import { 
  X, Send, Headset, MicOff, Clock, Paperclip, Edit2, Trash2, Zap, FileText, Download, Loader2, CalendarClock, Save, AlertTriangle, History, MessageCircle, ShieldAlert, User, Bot, Mic, Video, CheckCircle, Search, Activity, ChevronDown, Check, Copy, Reply, Forward, Maximize2, MoreVertical, Info
} from 'lucide-react';
import { liveApiService, UpdateConnectionState } from '../services/liveApiService';
import { reportUiFailure, reportUiRecovery } from '../services/uiFailureMonitor';
import { MediaSelectorModal } from './MediaSelectorModal.tsx';
import { VoiceRecorder } from './VoiceRecorder.tsx';
import { QuickReply } from '../types';

interface ChatDrawerProps {
  driver: Driver | null;
  onClose: () => void;
  onSendMessage: (text: string, options?: { mediaUrl?: string, mediaType?: string }) => void;
  onUpdateDriver: (id: string, updates: Partial<Driver>) => void;
  updateConnectionState?: UpdateConnectionState;
  userName?: string;
  botSettings?: any;
}

const QUICK_REPLIES: QuickReply[] = [
  { id: '1', title: 'Welcome', text: 'Hi, welcome to our platform! How can I help you today?', category: 'Greeting' },
  { id: '2', title: 'Human Mode', text: 'I am taking over this chat to assist you personally.', category: 'Agent' },
  { id: '3', title: 'Doc Request', text: 'Could you please upload a clear photo of your driving license?', category: 'Onboarding' },
  { id: '4', title: 'Approved', text: 'Great news! Your documents have been approved. You are ready to start.', category: 'Status' },
  { id: '5', title: 'Rejected', text: 'Unfortunately, your document was rejected. Please re-upload a clearer version.', category: 'Status' },
];

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
  const [isHumanModeLoading, setIsHumanModeLoading] = useState(false);
  
  const [showMediaPicker, setShowMediaPicker] = useState(false);
  const [selectedMedia, setSelectedMedia] = useState<{url: string, type: 'image' | 'video' | 'document' | 'audio'} | null>(null);
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);

  const [documents, setDocuments] = useState<DriverDocument[]>([]);
  const [scheduledMessages, setScheduledMessages] = useState<ScheduledMessage[]>([]);
  const [localMessages, setLocalMessages] = useState<Message[]>([]);
  
  const [activeTab, setActiveTab] = useState<'chat' | 'docs' | 'logs'>('chat');
  const [searchQuery, setSearchQuery] = useState('');
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

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

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    setIsAtBottom(scrollHeight - scrollTop - clientHeight < 50);
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const filteredMessages = localMessages.filter(msg => 
    !searchQuery || msg.text?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const groupedMessages = filteredMessages.reduce((groups: { [key: string]: Message[] }, message) => {
    const date = new Date(message.timestamp).toLocaleDateString();
    if (!groups[date]) groups[date] = [];
    groups[date].push(message);
    return groups;
  }, {});

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
        } else {
            await onSendMessage(replyText, selectedMedia ? { mediaUrl: selectedMedia.url, mediaType: selectedMedia.type } : undefined);
        }
        setReplyText('');
        setSelectedMedia(null);
        setShowQuickReplies(false);
    } catch(e: any) {
        alert(`Failed: ${e.message}`);
    } finally {
        setIsSending(false);
    }
  };

  const handleVoiceSend = async (blob: Blob) => {
    if (!driver) return;
    setIsSending(true);
    try {
      const file = new File([blob], `voice_recording_${Date.now()}.ogg`, { type: 'audio/ogg' });
      const uploadResult = await liveApiService.uploadMedia(file, `voice_recordings/${driver.id}`);
      if (uploadResult.success) {
        await liveApiService.sendMessage(driver.id, '', { 
          mediaUrl: uploadResult.url, 
          mediaType: 'audio'
        });
      }
    } catch (error) {
      console.error('Failed to send voice recording:', error);
    } finally {
      setIsSending(false);
      setIsRecordingVoice(false);
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
    <div className="fixed inset-0 z-50 overflow-hidden flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-md transition-opacity" onClick={onClose} />
      
      <div className="relative w-full max-w-6xl h-full bg-white shadow-2xl rounded-3xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-300">
        {/* Header */}
        <div className="bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between z-20">
          <div className="flex items-center gap-4">
            <div className="relative">
              <div className="h-12 w-12 bg-gradient-to-br from-emerald-400 to-emerald-600 rounded-2xl flex items-center justify-center text-white text-xl font-bold shadow-lg shadow-emerald-100">
                {driver.name.charAt(0)}
              </div>
              <div className={`absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-white ${updateConnectionState === 'connected' ? 'bg-green-500' : 'bg-amber-500'}`} />
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-bold text-gray-900">{driver.name}</h2>
                <MetaWindowTimer lastMessageTime={driver.lastMessageTime} />
              </div>
              <div className="flex items-center gap-2 text-gray-500 text-xs">
                <span className="font-mono">{driver.phoneNumber}</span>
                <span className="w-1 h-1 bg-gray-300 rounded-full" />
                <span className="capitalize">{driver.source} Lead</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden md:flex items-center bg-gray-50 rounded-xl px-3 py-1.5 border border-gray-100">
              <Search size={16} className="text-gray-400 mr-2" />
              <input 
                type="text" 
                placeholder="Search messages..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-transparent border-none text-sm focus:ring-0 w-40"
              />
            </div>

            <div className="h-8 w-px bg-gray-100 mx-2" />

            <button 
              onClick={handleToggleHumanMode}
              disabled={isHumanModeLoading}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
                driver.isHumanMode 
                  ? 'bg-amber-100 text-amber-700 border border-amber-200 shadow-sm shadow-amber-100' 
                  : 'bg-gray-100 text-gray-600 border border-gray-200 hover:bg-gray-200'
              }`}
            >
              {isHumanModeLoading ? <Loader2 size={14} className="animate-spin" /> : driver.isHumanMode ? <User size={14} /> : <Bot size={14} />}
              {driver.isHumanMode ? 'Human Mode' : 'Bot Active'}
            </button>

            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-xl transition-colors text-gray-400">
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex px-6 border-b border-gray-100 bg-white">
          {[
            { id: 'chat', label: 'Chat', icon: MessageCircle },
            { id: 'docs', label: 'Documents', icon: FileText },
            { id: 'logs', label: 'Activity Logs', icon: Activity },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-2 px-6 py-3 text-sm font-bold transition-all relative ${
                activeTab === tab.id ? 'text-emerald-600' : 'text-gray-400 hover:text-gray-600'
              }`}
            >
              <tab.icon size={16} />
              {tab.label}
              {activeTab === tab.id && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-500 rounded-t-full" />
              )}
            </button>
          ))}
        </div>

        <div className="flex-1 flex overflow-hidden bg-gray-50/50">
          {/* Main Content Area */}
          <div className="flex-1 flex flex-col relative overflow-hidden">
            {activeTab === 'chat' ? (
              <>
                <div 
                  className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar"
                  onScroll={handleScroll}
                >
                  {Object.entries(groupedMessages).map(([date, msgs]) => (
                    <div key={date} className="space-y-6">
                      <div className="flex justify-center">
                        <span className="px-3 py-1 bg-white border border-gray-100 rounded-full text-[10px] font-bold text-gray-400 uppercase tracking-widest shadow-sm">
                          {date === new Date().toLocaleDateString() ? 'Today' : date}
                        </span>
                      </div>
                      
                      {msgs.map((msg) => {
                        const media = getMessageMedia(msg);
                        const isOwn = msg.sender !== 'driver';
                        
                        return (
                          <div key={msg.id} className={`flex ${isOwn ? 'justify-end' : 'justify-start'} group`}>
                            <div className={`flex flex-col max-w-[75%] ${isOwn ? 'items-end' : 'items-start'}`}>
                              <div className={`relative p-1 rounded-2xl shadow-sm transition-all hover:shadow-md ${
                                isOwn 
                                  ? 'bg-emerald-500 text-white rounded-tr-none' 
                                  : 'bg-white text-gray-900 rounded-tl-none border border-gray-100'
                              }`}>
                                {/* Hover Actions */}
                                <div className={`absolute top-0 ${isOwn ? '-left-12' : '-right-12'} opacity-0 group-hover:opacity-100 transition-opacity flex flex-col gap-1`}>
                                  <button className="p-1.5 bg-white border border-gray-100 rounded-lg text-gray-400 hover:text-emerald-500 shadow-sm"><Reply size={14}/></button>
                                  <button className="p-1.5 bg-white border border-gray-100 rounded-lg text-gray-400 hover:text-blue-500 shadow-sm"><Forward size={14}/></button>
                                  <button className="p-1.5 bg-white border border-gray-100 rounded-lg text-gray-400 hover:text-red-500 shadow-sm"><Trash2 size={14}/></button>
                                </div>

                                {media.url && (
                                  <div className="mb-1 overflow-hidden rounded-xl">
                                    {media.type === 'video' ? (
                                      <div className="relative group/media">
                                        <video src={media.url} className="w-full max-h-64 object-cover" />
                                        <div className="absolute inset-0 bg-black/20 flex items-center justify-center opacity-0 group-hover/media:opacity-100 transition-opacity">
                                          <button className="p-3 bg-white/20 backdrop-blur-md rounded-full text-white"><Maximize2 size={24}/></button>
                                        </div>
                                      </div>
                                    ) : media.type === 'audio' ? (
                                      <div className={`flex items-center gap-3 p-3 ${isOwn ? 'bg-emerald-600' : 'bg-gray-50'}`}>
                                        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isOwn ? 'bg-emerald-700' : 'bg-gray-200 text-gray-500'}`}>
                                          <Mic size={18} />
                                        </div>
                                        <audio src={media.url} controls className="h-8 w-40" />
                                      </div>
                                    ) : media.type === 'document' ? (
                                      <a href={media.url} target="_blank" rel="noopener noreferrer" className={`flex items-center gap-3 p-3 transition-colors ${isOwn ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-gray-50 hover:bg-gray-100'}`}>
                                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${isOwn ? 'bg-emerald-700' : 'bg-gray-200 text-gray-500'}`}>
                                          <FileText size={20} />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                          <p className="text-xs font-bold truncate">Document</p>
                                          <p className="text-[10px] opacity-70">Click to view</p>
                                        </div>
                                      </a>
                                    ) : (
                                      <img src={media.url} className="w-full max-h-80 object-cover cursor-pointer hover:scale-105 transition-transform" alt="media" referrerPolicy="no-referrer" />
                                    )}
                                  </div>
                                )}

                                <div className="px-4 py-2">
                                  {renderMessageText(msg.text)}
                                  <div className={`flex items-center justify-end gap-1.5 mt-1 text-[10px] ${isOwn ? 'text-emerald-100' : 'text-gray-400'}`}>
                                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    {isOwn && (
                                      <div className="flex">
                                        <CheckCircle size={10} className={msg.status === 'read' ? 'text-blue-300' : ''} />
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                              <span className="text-[10px] text-gray-400 mt-1 px-1">
                                {msg.senderType === 'bot' ? 'AI Assistant' : msg.senderType === 'staff' ? (userName || 'Staff') : ''}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))}

                  {scheduledMessages.length > 0 && (
                    <div className="space-y-4 pt-6">
                      <div className="flex items-center gap-3 justify-center">
                        <div className="h-px bg-gray-200 flex-1" />
                        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest flex items-center gap-2">
                          <CalendarClock size={14} /> Scheduled Queue
                        </span>
                        <div className="h-px bg-gray-200 flex-1" />
                      </div>
                      {scheduledMessages.map(msg => (
                        <div key={msg.id} className="flex justify-end">
                          <div className="max-w-[80%] bg-amber-50/50 border-2 border-dashed border-amber-200 rounded-2xl p-4 relative group">
                            <div className="flex items-center justify-between mb-3">
                              <div className="flex items-center gap-2 text-[10px] font-bold text-amber-600 uppercase">
                                <Clock size={12} /> {new Date(msg.scheduledTime).toLocaleString()}
                              </div>
                              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button onClick={() => handleSendNowScheduled(msg.id)} className="p-1.5 bg-white text-green-600 rounded-lg shadow-sm hover:bg-green-50"><Zap size={14}/></button>
                                <button onClick={() => openEditModal(msg)} className="p-1.5 bg-white text-blue-600 rounded-lg shadow-sm hover:bg-blue-50"><Edit2 size={14}/></button>
                                <button onClick={() => handleCancelScheduled(msg.id)} className="p-1.5 bg-white text-red-600 rounded-lg shadow-sm hover:bg-red-50"><Trash2 size={14}/></button>
                              </div>
                            </div>
                            {msg.payload?.mediaUrl && renderMediaPreview(msg.payload.mediaUrl, msg.payload.mediaType)}
                            <p className="text-sm text-gray-700 leading-relaxed">{msg.payload?.text}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Scroll to bottom button */}
                {!isAtBottom && (
                  <button 
                    onClick={scrollToBottom}
                    className="absolute bottom-28 right-8 p-3 bg-white text-emerald-500 rounded-full shadow-xl border border-gray-100 hover:bg-emerald-50 transition-all animate-bounce"
                  >
                    <ChevronDown size={20} />
                  </button>
                )}

                {/* Input Area */}
                <div className="p-6 bg-white border-t border-gray-100">
                  {!isWindowActive ? (
                    <div className="bg-gray-50 rounded-2xl p-6 text-center border border-dashed border-gray-200">
                      <History size={32} className="mx-auto text-gray-300 mb-3" />
                      <h4 className="text-sm font-bold text-gray-900 mb-1">Window Expired</h4>
                      <p className="text-xs text-gray-500">The 24h response window has closed. Wait for a new message from the customer.</p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {/* Quick Replies Bar */}
                      <div className="flex items-center gap-2 overflow-x-auto pb-2 no-scrollbar">
                        <button 
                          onClick={() => setShowQuickReplies(!showQuickReplies)}
                          className={`flex-shrink-0 flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] font-bold transition-all ${
                            showQuickReplies ? 'bg-emerald-500 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                          }`}
                        >
                          <Zap size={12} />
                          Quick Replies
                        </button>
                        {QUICK_REPLIES.map(qr => (
                          <button
                            key={qr.id}
                            onClick={() => setReplyText(qr.text)}
                            className="flex-shrink-0 px-3 py-1.5 bg-white border border-gray-200 rounded-full text-[10px] font-medium text-gray-600 hover:border-emerald-300 hover:text-emerald-600 transition-all"
                          >
                            {qr.title}
                          </button>
                        ))}
                      </div>

                      {selectedMedia && (
                        <div className="flex items-center justify-between p-3 bg-emerald-50 rounded-2xl border border-emerald-100 animate-in slide-in-from-bottom-2">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center text-emerald-600">
                              {selectedMedia.type === 'image' ? <Paperclip size={20} /> : <FileText size={20} />}
                            </div>
                            <div>
                              <p className="text-xs font-bold text-emerald-900 capitalize">{selectedMedia.type} Selected</p>
                              <p className="text-[10px] text-emerald-600">Ready to send with message</p>
                            </div>
                          </div>
                          <button onClick={() => setSelectedMedia(null)} className="p-1.5 hover:bg-emerald-100 rounded-full text-emerald-600">
                            <X size={16} />
                          </button>
                        </div>
                      )}

                      <div className="flex items-end gap-3">
                        <div className="flex-1 bg-gray-50 rounded-2xl border border-gray-200 focus-within:border-emerald-500 focus-within:ring-4 focus-within:ring-emerald-500/10 transition-all">
                          {isRecordingVoice ? (
                            <div className="p-2">
                              <VoiceRecorder 
                                onSend={handleVoiceSend} 
                                onCancel={() => setIsRecordingVoice(false)} 
                                isSending={isSending}
                              />
                            </div>
                          ) : (
                            <div className="flex flex-col">
                              <textarea
                                value={replyText}
                                onChange={(e) => setReplyText(e.target.value)}
                                placeholder="Type your message here..."
                                className="w-full bg-transparent border-none focus:ring-0 p-4 text-sm min-h-[60px] max-h-40 custom-scrollbar resize-none"
                                onKeyDown={e => {
                                  if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    handleSend();
                                  }
                                }}
                              />
                              <div className="flex items-center justify-between px-3 py-2 border-t border-gray-100">
                                <div className="flex items-center gap-1">
                                  <button onClick={() => setShowMediaPicker(true)} className="p-2 text-gray-400 hover:text-emerald-500 hover:bg-emerald-50 rounded-xl transition-all">
                                    <Paperclip size={18} />
                                  </button>
                                  <button onClick={() => setIsRecordingVoice(true)} className="p-2 text-gray-400 hover:text-emerald-500 hover:bg-emerald-50 rounded-xl transition-all">
                                    <Mic size={18} />
                                  </button>
                                  <button onClick={() => setShowSchedule(!showSchedule)} className={`p-2 rounded-xl transition-all ${showSchedule ? 'text-amber-500 bg-amber-50' : 'text-gray-400 hover:text-amber-500 hover:bg-amber-50'}`}>
                                    <Clock size={18} />
                                  </button>
                                </div>
                                
                                {showSchedule && (
                                  <div className="flex items-center gap-2 animate-in slide-in-from-right-2">
                                    <input 
                                      type="datetime-local" 
                                      value={scheduleTime} 
                                      onChange={(e) => setScheduleTime(e.target.value)}
                                      className="text-[10px] font-bold border-none bg-amber-50 text-amber-700 rounded-lg p-1 focus:ring-0"
                                    />
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                        
                        {!isRecordingVoice && (
                          <button
                            onClick={handleSend}
                            disabled={(!replyText.trim() && !selectedMedia) || isSending}
                            className="w-14 h-14 bg-emerald-500 text-white rounded-2xl flex items-center justify-center shadow-lg shadow-emerald-200 hover:bg-emerald-600 active:scale-95 transition-all disabled:opacity-50 disabled:shadow-none"
                          >
                            {isSending ? <Loader2 size={24} className="animate-spin" /> : <Send size={24} />}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : activeTab === 'docs' ? (
              <div className="flex-1 overflow-y-auto p-8 space-y-6">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-lg font-bold text-gray-900">Driver Documents</h3>
                  <button className="text-xs font-bold text-emerald-600 hover:underline">Request New Document</button>
                </div>
                
                {documents.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 bg-white rounded-3xl border border-dashed border-gray-200">
                    <div className="w-16 h-16 bg-gray-50 rounded-full flex items-center justify-center mb-4 text-gray-300">
                      <FileText size={32} />
                    </div>
                    <p className="text-gray-500 font-medium">No documents found</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {documents.map(doc => (
                      <div key={doc.id} className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm hover:shadow-md transition-all group">
                        <div className="flex items-start justify-between mb-4">
                          <div className="flex items-center gap-3">
                            <div className="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center text-blue-600">
                              <FileText size={24} />
                            </div>
                            <div>
                              <h4 className="text-sm font-bold text-gray-900 capitalize">{doc.docType.replace('_', ' ')}</h4>
                              <p className="text-[10px] text-gray-400">{new Date(doc.timestamp).toLocaleDateString()}</p>
                            </div>
                          </div>
                          <span className={`text-[10px] font-bold px-2 py-1 rounded-lg ${
                            doc.verificationStatus === 'approved' ? 'bg-green-50 text-green-600' :
                            doc.verificationStatus === 'rejected' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600'
                          }`}>
                            {doc.verificationStatus.toUpperCase()}
                          </span>
                        </div>
                        <div className="flex gap-2">
                          <a href={doc.url} target="_blank" rel="noreferrer" className="flex-1 flex items-center justify-center gap-2 py-2 bg-gray-50 text-gray-600 rounded-xl text-xs font-bold hover:bg-gray-100 transition-colors">
                            <Maximize2 size={14} /> View
                          </a>
                          <a href={doc.url} download className="p-2 bg-gray-50 text-gray-600 rounded-xl hover:bg-gray-100 transition-colors">
                            <Download size={14} />
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-8 space-y-4">
                <h3 className="text-lg font-bold text-gray-900 mb-4">System Activity Logs</h3>
                <div className="space-y-3">
                  {[
                    { id: 1, type: 'status', text: 'Lead status changed to "Qualified"', time: '2 hours ago', icon: Zap, color: 'text-amber-500 bg-amber-50' },
                    { id: 2, type: 'bot', text: 'Bot flow "Onboarding" completed successfully', time: '5 hours ago', icon: Bot, color: 'text-blue-500 bg-blue-50' },
                    { id: 3, type: 'doc', text: 'New document "Driving License" uploaded', time: 'Yesterday', icon: FileText, color: 'text-emerald-500 bg-emerald-50' },
                    { id: 4, type: 'system', text: 'Chat session initiated via Meta API', time: '2 days ago', icon: Activity, color: 'text-gray-500 bg-gray-50' },
                  ].map(log => (
                    <div key={log.id} className="flex items-start gap-4 p-4 bg-white rounded-2xl border border-gray-100 shadow-sm">
                      <div className={`p-2 rounded-xl ${log.color}`}>
                        <log.icon size={18} />
                      </div>
                      <div className="flex-1">
                        <p className="text-sm text-gray-800 font-medium">{log.text}</p>
                        <p className="text-[10px] text-gray-400 mt-1">{log.time}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right Sidebar - Driver Details */}
          <div className="hidden lg:flex w-80 flex-col bg-white border-l border-gray-100 overflow-y-auto custom-scrollbar">
            <div className="p-8 space-y-8">
              {/* Profile Section */}
              <div className="text-center">
                <div className="w-24 h-24 bg-gradient-to-br from-gray-50 to-gray-100 rounded-3xl mx-auto mb-4 flex items-center justify-center text-3xl font-bold text-gray-300 border border-gray-100 shadow-inner">
                  {driver.name.charAt(0)}
                </div>
                <h3 className="text-xl font-bold text-gray-900 mb-1">{driver.name}</h3>
                <p className="text-sm text-gray-500 mb-4">{driver.phoneNumber}</p>
                <div className="flex justify-center gap-2">
                  <span className="px-3 py-1 bg-emerald-50 text-emerald-600 rounded-full text-[10px] font-bold uppercase tracking-wider border border-emerald-100">
                    {driver.status}
                  </span>
                  <span className="px-3 py-1 bg-blue-50 text-blue-600 rounded-full text-[10px] font-bold uppercase tracking-wider border border-blue-100">
                    {driver.source}
                  </span>
                </div>
              </div>

              <div className="h-px bg-gray-100" />

              {/* Quick Info */}
              <div className="space-y-4">
                <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Quick Details</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-3 bg-gray-50 rounded-2xl border border-gray-100">
                    <p className="text-[10px] text-gray-400 mb-1">Last Active</p>
                    <p className="text-xs font-bold text-gray-900">{new Date(driver.lastMessageTime).toLocaleDateString()}</p>
                  </div>
                  <div className="p-3 bg-gray-50 rounded-2xl border border-gray-100">
                    <p className="text-[10px] text-gray-400 mb-1">Messages</p>
                    <p className="text-xs font-bold text-gray-900">{localMessages.length}</p>
                  </div>
                </div>
              </div>

              {/* Bot Context */}
              <div className="space-y-4">
                <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Bot Context</h4>
                <div className="p-4 bg-gray-900 rounded-2xl text-white">
                  <div className="flex items-center gap-2 mb-3">
                    <Bot size={16} className="text-emerald-400" />
                    <span className="text-xs font-bold">Current Flow</span>
                  </div>
                  <p className="text-xs text-gray-400 mb-2">Onboarding Flow v2.1</p>
                  <div className="w-full bg-gray-800 h-1.5 rounded-full overflow-hidden">
                    <div className="bg-emerald-500 h-full w-2/3" />
                  </div>
                  <p className="text-[10px] text-gray-500 mt-2">Step 4 of 6: Document Upload</p>
                </div>
              </div>

              {/* Quick Actions */}
              <div className="space-y-4">
                <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Quick Actions</h4>
                <div className="space-y-2">
                  <button className="w-full flex items-center justify-between p-3 bg-white border border-gray-100 rounded-2xl text-xs font-bold text-gray-700 hover:bg-gray-50 transition-all">
                    <span className="flex items-center gap-2"><Zap size={14} className="text-amber-500" /> Qualify Lead</span>
                    <ChevronDown size={14} />
                  </button>
                  <button className="w-full flex items-center justify-between p-3 bg-white border border-gray-100 rounded-2xl text-xs font-bold text-gray-700 hover:bg-gray-50 transition-all">
                    <span className="flex items-center gap-2"><ShieldAlert size={14} className="text-red-500" /> Flag for Review</span>
                    <ChevronDown size={14} />
                  </button>
                </div>
              </div>
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
