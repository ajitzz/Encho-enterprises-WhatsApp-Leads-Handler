
import React, { useState, useEffect, useRef } from 'react';
import { Lead, LeadStatus, Company } from '../types';
import { 
  X, Send, Image as ImageIcon, Video, CheckCircle, UserX, 
  Car, Clock, ShieldCheck, Facebook, Globe, Headset, MicOff, 
  Phone, FileText, Sparkles, Plane, MapPin, Briefcase
} from 'lucide-react';

interface ChatDrawerProps {
  driver: Lead | null;
  company: Company;
  onClose: () => void;
  onSendMessage: (text: string) => void;
  onUpdateDriver: (id: string, updates: Partial<Lead>) => void;
}

export const ChatDrawer: React.FC<ChatDrawerProps> = ({ driver, company, onClose, onSendMessage, onUpdateDriver }) => {
  const [replyText, setReplyText] = useState('');
  const [localNotes, setLocalNotes] = useState('');
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

  const handleSend = () => {
    if (!replyText.trim()) return;
    onSendMessage(replyText);
    setReplyText('');
  };

  const handleUpdateDetails = (updates: Partial<Lead>) => {
    onUpdateDriver(driver.id, updates);
  };

  const handleSaveNotes = () => onUpdateDriver(driver.id, { notes: localNotes });

  // Dynamic Icons based on Company Type
  const Field1Icon = company.type === 'travel' ? Plane : Car;
  const Field2Icon = company.type === 'travel' ? MapPin : Clock;

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
                    <span className="bg-gray-700 text-gray-300 text-[10px] px-2 py-0.5 rounded-full flex items-center gap-1 font-medium">
                        {driver.source}
                    </span>
                 </div>
                 <p className="text-gray-400 text-sm font-mono">{driver.phoneNumber}</p>
               </div>
            </div>
            
            <div className="flex items-center gap-4">
               <button onClick={onClose} className="p-2 hover:bg-gray-800 rounded-full transition-colors"><X size={20} /></button>
            </div>
          </div>

          <div className="flex-1 flex overflow-hidden">
            {/* Chat History */}
            <div className="flex-1 flex flex-col border-r border-gray-200 min-w-[400px] relative bg-gray-50">
               <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  {messages.map((msg) => (
                    <div key={msg.id} className={`flex ${msg.sender === 'driver' ? 'justify-start' : 'justify-end'}`}>
                        <div className={`max-w-[80%] rounded-2xl px-4 py-3 shadow-sm ${msg.sender === 'driver' ? 'bg-white text-gray-900 rounded-tl-none' : 'bg-blue-600 text-white rounded-tr-none'}`}>
                            {msg.imageUrl && <img src={msg.imageUrl} className="mb-2 rounded-lg max-h-60" />}
                            <p className="text-sm">{msg.text}</p>
                        </div>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
               </div>
               <div className="p-4 bg-white border-t border-gray-200 flex gap-3">
                  <textarea value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="Type a message..." className="flex-1 border rounded-xl p-3 h-14 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <button onClick={handleSend} className="bg-black text-white p-3 rounded-xl"><Send size={20} /></button>
               </div>
            </div>

            {/* Profile & Logic */}
            <div className="w-[400px] bg-white flex flex-col overflow-y-auto border-l border-gray-200 p-6 space-y-8">
                
                {/* Notes */}
                <section>
                    <h3 className="font-semibold text-gray-900 mb-2 flex items-center gap-2"><FileText size={18} className="text-purple-600" /> Smart Notes</h3>
                    <textarea 
                        value={localNotes}
                        onChange={(e) => setLocalNotes(e.target.value)}
                        onBlur={handleSaveNotes}
                        className="w-full h-32 p-3 text-sm bg-yellow-50/50 border border-yellow-200 rounded-lg focus:ring-yellow-400 outline-none resize-none"
                        placeholder="AI Notes..."
                    />
                </section>

                {/* Qualification (Dynamic Labels) */}
                <section>
                   <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2"><ShieldCheck size={18} className="text-blue-600" /> Qualification</h3>
                   <div className="space-y-3">
                      <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-100">
                        <span className="text-sm text-gray-600">{company.terminology.check1Label}</span>
                        <button onClick={() => handleUpdateDetails({ qualificationChecks: { ...driver.qualificationChecks, check1: !driver.qualificationChecks?.check1 } })} className={`p-1 rounded-full ${driver.qualificationChecks?.check1 ? 'text-green-500 bg-green-100' : 'text-gray-300 bg-gray-200'}`}><CheckCircle size={20} /></button>
                      </div>
                      <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-100">
                        <span className="text-sm text-gray-600">{company.terminology.check2Label}</span>
                        <button onClick={() => handleUpdateDetails({ qualificationChecks: { ...driver.qualificationChecks, check2: !driver.qualificationChecks?.check2 } })} className={`p-1 rounded-full ${driver.qualificationChecks?.check2 ? 'text-green-500 bg-green-100' : 'text-gray-300 bg-gray-200'}`}><CheckCircle size={20} /></button>
                      </div>
                   </div>
                </section>

                {/* Dynamic Fields */}
                <section>
                   <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2"><Field1Icon size={18} className="text-blue-600" /> {company.terminology.field1Label}</h3>
                   <input type="text" value={driver.customField1 || ''} onChange={(e) => handleUpdateDetails({ customField1: e.target.value })} className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none" />
                </section>

                <section>
                   <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2"><Field2Icon size={18} className="text-blue-600" /> {company.terminology.field2Label}</h3>
                   <input type="text" value={driver.customField2 || ''} onChange={(e) => handleUpdateDetails({ customField2: e.target.value })} className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none" />
                </section>

                {/* Documents */}
                <section>
                   <h3 className="font-semibold text-gray-900 mb-4 text-sm">Documents</h3>
                   {documents.length > 0 ? (
                     <div className="grid grid-cols-2 gap-3">
                       {documents.map((doc, idx) => (
                         <a key={idx} href={doc} target="_blank" className="block relative aspect-video rounded-lg overflow-hidden border border-gray-200">
                           <img src={doc} className="w-full h-full object-cover" />
                         </a>
                       ))}
                     </div>
                   ) : <div className="text-center py-6 bg-gray-50 rounded-lg border border-dashed text-gray-400 text-xs">No documents</div>}
                </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
