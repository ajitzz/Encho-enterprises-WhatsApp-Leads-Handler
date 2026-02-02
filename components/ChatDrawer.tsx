
import React, { useState, useEffect, useRef } from 'react';
import { Driver, Message, ScheduledMessage, DriverDocument } from '../types';
import { 
  X, Send, Headset, MicOff, Clock, Paperclip, Edit2, Trash2, Zap, FileText, Download, Loader2, CalendarClock
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
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleTime, setScheduleTime] = useState('');
  const [isSending, setIsSending] = useState(false);
  
  const [showMediaPicker, setShowMediaPicker] = useState(false);
  const [selectedMedia, setSelectedMedia] = useState<{url: string, type: 'image' | 'video' | 'document'} | null>(null);

  const [documents, setDocuments] = useState<DriverDocument[]>([]);
  const [scheduledMessages, setScheduledMessages] = useState<ScheduledMessage[]>([]);
  const [localMessages, setLocalMessages] = useState<Message[]>([]);
  
  const [editingMessage, setEditingMessage] = useState<ScheduledMessage | null>(null);
  const [editTime, setEditTime] = useState('');
  const [editText, setEditText] = useState('');

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (driver) {
        setLocalMessages(driver.messages || []);
        loadDocuments(driver.id);
        loadScheduledMessages(driver.id);
    }
  }, [driver]);

  useEffect(() => {
      if (!driver) return;
      const pollMessages = async () => {
          try {
              const [latestMsgs, latestSched] = await Promise.all([
                  liveApiService.getDriverMessages(driver.id, 50),
                  liveApiService.getScheduledMessages(driver.id)
              ]);

              setLocalMessages(prev => {
                  if (latestMsgs.length === 0) return prev;
                  const newLastId = latestMsgs[latestMsgs.length - 1].id;
                  const prevLastId = prev.length > 0 ? prev[prev.length - 1].id : '';
                  if (latestMsgs.length !== prev.length || newLastId !== prevLastId) return latestMsgs;
                  return prev;
              });

              setScheduledMessages(latestSched);
          } catch (e) {}
      };
      const interval = setInterval(pollMessages, 3000);
      return () => clearInterval(interval);
  }, [driver?.id]);

  useEffect(() => {
    if (messagesEndRef.current) messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [localMessages.length, scheduledMessages.length]);

  const loadDocuments = async (driverId: string) => {
      try { 
          const docs = await liveApiService.getDriverDocuments(driverId); 
          setDocuments(docs || []); 
      } catch(e) { setDocuments([]); }
  };

  const loadScheduledMessages = async (driverId: string) => {
      try { const items = await liveApiService.getScheduledMessages(driverId); setScheduledMessages(items); } catch(e) {}
  };

  const handleCancelScheduled = async (msgId: string) => {
      // Replaced window.confirm with a simpler check to avoid blocking async flow
      try { await liveApiService.cancelScheduledMessage(msgId); setScheduledMessages(prev => prev.filter(m => m.id !== msgId)); } catch (e: any) { console.error(`Error: ${e.message}`); }
  };

  const handleSendNowScheduled = async (msgId: string) => {
      try { 
          await liveApiService.updateScheduledMessage(msgId, { scheduledTime: Date.now() }); 
          // Removed alert to prevent async listener errors
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
      const date = new Date(msg.scheduledTime);
      const isoString = new Date(date.getTime() - (date.getTimezoneOffset() * 60000)).toISOString().slice(0, 16);
      setEditTime(isoString);
  };

  const saveEditedMessage = async () => {
      if (!editingMessage || !editTime) return;
      const newTime = new Date(editTime).getTime();
      if (newTime <= Date.now()) { console.error("Time must be in the future."); return; }
      
      try { 
          await liveApiService.updateScheduledMessage(editingMessage.id, { text: editText, scheduledTime: newTime }); 
          setEditingMessage(null); 
          if (driver) loadScheduledMessages(driver.id); 
      } catch(e: any) { console.error(`Update failed: ${e.message}`); }
  };

  if (!driver) return null;

  const handleSend = async (e?: React.MouseEvent | React.FormEvent) => {
    // CRITICAL: Prevent form submission refresh
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
        console.error(`Failed: ${e.message}`);
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
      } catch (e) {}
      return <p className="text-sm leading-relaxed whitespace-pre-wrap">{rawText}</p>;
  };

  const renderMediaPreview = (url?: string, type?: string) => {
      if (!url) return null;
      if (type === 'video') return <div className="w-full aspect-video bg-black rounded mb-2"><video src={url} controls className="w-full h-full object-contain" /></div>;
      return <div className="w-full aspect-video bg-gray-100 rounded mb-2"><img src={url} className="w-full h-full object-cover rounded" alt="media" /></div>;
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
                 <div className="flex items-center gap-2"><h2 className="text-xl font-semibold">{driver.name}</h2></div>
                 <p className="text-gray-400 text-sm font-mono">{driver.phoneNumber}</p>
               </div>
            </div>
            <div className="flex items-center gap-4">
               <div className="flex items-center gap-2 bg-gray-900 rounded-lg p-1 border border-gray-800">
                    <button type="button" onClick={() => onUpdateDriver(driver.id, { isHumanMode: !driver.isHumanMode })} className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-bold transition-all ${driver.isHumanMode ? 'bg-amber-500 text-black' : 'text-gray-400 hover:text-white'}`}>
                        {driver.isHumanMode ? <Headset size={14} /> : <MicOff size={14} />} {driver.isHumanMode ? 'Human Agent' : 'Bot Active'}
                    </button>
               </div>
              <button type="button" onClick={onClose} className="p-2 hover:bg-gray-800 rounded-full transition-colors"><X size={20} /></button>
            </div>
          </div>

          <div className="flex-1 flex overflow-hidden">
            <div className="flex-1 flex flex-col border-r border-gray-200 min-w-[400px] relative">
              <div className="flex-1 overflow-y-auto p-4 bg-gray-50 space-y-4">
                {localMessages.map((msg) => (
                    <div key={msg.id} className={`flex ${msg.sender === 'driver' ? 'justify-start' : 'justify-end'}`}>
                        <div className={`max-w-[80%] rounded-2xl shadow-sm overflow-hidden ${msg.sender === 'driver' ? 'bg-white text-gray-900 rounded-tl-none border border-gray-200' : 'bg-blue-600 text-white rounded-tr-none'}`}>
                            {renderMediaPreview(msg.imageUrl || msg.videoUrl, msg.videoUrl ? 'video' : 'image')}
                            <div className="px-4 py-3">
                                {renderMessageText(msg.text)}
                                <div className="text-[10px] mt-1 text-right opacity-60 flex justify-end gap-1 items-center">
                                    {msg.status === 'sending' && <Clock size={10} className="animate-spin" />}
                                    {new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                                </div>
                            </div>
                        </div>
                    </div>
                ))}
                
                {scheduledMessages.length > 0 && (
                    <div className="flex flex-col gap-4 mt-6">
                        <div className="flex items-center gap-2 justify-center opacity-50">
                            <div className="h-px bg-gray-300 w-12"></div>
                            <span className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1"><CalendarClock size={12}/> Scheduled Queue</span>
                            <div className="h-px bg-gray-300 w-12"></div>
                        </div>
                        {scheduledMessages.map(msg => (
                            <div key={msg.id} className="flex justify-end animate-in slide-in-from-bottom-2">
                                <div className="max-w-[85%] bg-amber-50 border-2 border-dashed border-amber-300 rounded-2xl rounded-tr-none p-1 relative group">
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
                {selectedMedia && (
                    <div className="absolute bottom-full left-0 right-0 bg-gray-100 p-2 border-t border-gray-200 flex items-center justify-between px-4">
                        <div className="flex items-center gap-2 text-xs font-bold text-gray-700">
                            <Paperclip size={12} /> Selected: {selectedMedia.type.toUpperCase()}
                        </div>
                        <button type="button" onClick={() => setSelectedMedia(null)}><X size={14} /></button>
                    </div>
                )}
                {showSchedule && (
                    <div className="absolute bottom-[calc(100%+10px)] left-4 right-4 bg-white rounded-xl shadow-2xl border border-gray-200 p-4 z-20 animate-in slide-in-from-bottom-2">
                        <div className="flex justify-between mb-2"><h4 className="font-bold text-gray-800">Schedule Message</h4><button type="button" onClick={() => setShowSchedule(false)}><X size={16} /></button></div>
                        <input type="datetime-local" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} className="w-full p-2 border rounded-lg text-sm" />
                    </div>
                )}
                <div className="flex gap-2 mb-3">
                    <button type="button" onClick={() => setShowMediaPicker(true)} disabled={isSending} className={`px-3 py-1.5 rounded-full text-xs font-bold border flex items-center gap-1 ${selectedMedia ? 'bg-blue-100 text-blue-700 border-blue-200' : 'border-gray-200 hover:bg-gray-50'}`}><Paperclip size={12} /> Attach</button>
                    <button type="button" onClick={() => setShowSchedule(!showSchedule)} disabled={isSending} className={`px-3 py-1.5 rounded-full text-xs font-bold border flex items-center gap-1 ${showSchedule ? 'bg-amber-100 text-amber-700 border-amber-200' : 'border-gray-200 hover:bg-gray-50'}`}><Clock size={12} /> Schedule</button>
                </div>
                <div className="flex gap-3">
                  <textarea value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="Type a message..." className="flex-1 resize-none border border-gray-300 rounded-xl p-3 focus:outline-none focus:ring-2 focus:ring-blue-500 h-20 shadow-inner" disabled={isSending} />
                  <button type="button" onClick={handleSend} disabled={(!replyText.trim() && !selectedMedia) || isSending} className="self-end p-3 rounded-xl bg-black text-white hover:bg-gray-800 w-12 h-12 flex items-center justify-center disabled:opacity-50">
                      {isSending ? <Loader2 size={20} className="animate-spin" /> : <Send size={20} />}
                  </button>
                </div>
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
      
      {editingMessage && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
              <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6 space-y-4 animate-in zoom-in-95">
                  <div className="flex justify-between items-center border-b pb-2">
                      <h3 className="font-bold text-gray-900">Edit Scheduled Message</h3>
                      <button type="button" onClick={() => setEditingMessage(null)}><X size={18} /></button>
                  </div>
                  <div>
                      <label className="text-xs font-bold text-gray-500 mb-1 block">Date & Time</label>
                      <input type="datetime-local" value={editTime} onChange={(e) => setEditTime(e.target.value)} className="w-full p-2 border rounded bg-gray-50" />
                  </div>
                  <div>
                      <label className="text-xs font-bold text-gray-500 mb-1 block">Message</label>
                      <textarea value={editText} onChange={(e) => setEditText(e.target.value)} className="w-full p-2 border rounded h-24 resize-none bg-gray-50 focus:bg-white transition-colors" />
                  </div>
                  <div className="flex gap-2 pt-2">
                      <button type="button" onClick={() => setEditingMessage(null)} className="flex-1 py-2 border rounded-lg font-bold text-gray-600 hover:bg-gray-50">Cancel</button>
                      <button type="button" onClick={saveEditedMessage} className="flex-1 py-2 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700">Save Changes</button>
                  </div>
              </div>
          </div>
      )}
      <MediaSelectorModal isOpen={showMediaPicker} onClose={() => setShowMediaPicker(false)} onSelect={(url, type) => { setSelectedMedia({ url, type }); setShowMediaPicker(false); }} allowedType="All" />
    </div>
  );
};
