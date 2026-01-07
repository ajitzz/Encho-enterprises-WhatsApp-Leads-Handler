
import React, { useState, useEffect, useRef } from 'react';
import { Driver, Message, LeadStatus, OnboardingStep } from '../types';
import { 
  X, 
  Send, 
  Image as ImageIcon, 
  Video, 
  CheckCircle, 
  UserX, 
  Car, 
  Clock, 
  ShieldCheck, 
  ChevronRight, 
  Facebook, 
  Globe, 
  Headset, 
  MicOff 
} from 'lucide-react';

interface ChatDrawerProps {
  driver: Driver | null;
  onClose: () => void;
  onSendMessage: (text: string) => void;
  onUpdateDriver: (id: string, updates: Partial<Driver>) => void;
}

export const ChatDrawer: React.FC<ChatDrawerProps> = ({ driver, onClose, onSendMessage, onUpdateDriver }) => {
  const [replyText, setReplyText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Safe accessors for array properties
  const messages = driver && Array.isArray(driver.messages) ? driver.messages : [];
  const documents = driver && Array.isArray(driver.documents) ? driver.documents : [];

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  if (!driver) return null;

  const handleSend = () => {
    if (!replyText.trim()) return;
    onSendMessage(replyText);
    setReplyText('');
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Helper to update specific driver fields
  const handleUpdateDetails = (updates: Partial<Driver>) => {
    onUpdateDriver(driver.id, updates);
  };
  
  const toggleHumanMode = () => {
      const newState = !driver.isHumanMode;
      // 1. Update backend state
      onUpdateDriver(driver.id, { isHumanMode: newState });
      
      // 2. If turning ON, send the specific message
      if (newState) {
          onSendMessage("Now our executive on the line to connect");
      }
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
                    {driver.source === 'Meta Ad' && (
                        <span className="bg-blue-600 text-[10px] px-2 py-0.5 rounded-full flex items-center gap-1 font-medium">
                            <Facebook size={10} /> Meta Ad
                        </span>
                    )}
                    {driver.source === 'Organic' && (
                         <span className="bg-gray-700 text-gray-300 text-[10px] px-2 py-0.5 rounded-full flex items-center gap-1 font-medium">
                            <Globe size={10} /> Organic
                        </span>
                    )}
                 </div>
                 <p className="text-gray-400 text-sm font-mono">{driver.phoneNumber}</p>
               </div>
            </div>
            
            <div className="flex items-center gap-4">
               {/* Human Agent Toggle */}
               <div className="flex items-center gap-2 bg-gray-900 rounded-lg p-1 border border-gray-800">
                    <button 
                        onClick={toggleHumanMode}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-bold transition-all ${driver.isHumanMode ? 'bg-amber-500 text-black' : 'text-gray-400 hover:text-white'}`}
                        title={driver.isHumanMode ? 'Bot is Stopped' : 'Bot is Active'}
                    >
                        {driver.isHumanMode ? <Headset size={14} /> : <MicOff size={14} />}
                        {driver.isHumanMode ? 'Human Agent Mode' : 'Automation Active'}
                    </button>
               </div>

               <select 
                  className="bg-gray-800 text-white text-sm border-none rounded-md px-3 py-1.5 cursor-pointer outline-none focus:ring-2 focus:ring-blue-500"
                  value={driver.status}
                  onChange={(e) => onUpdateDriver(driver.id, { status: e.target.value as LeadStatus })}
                >
                  {Object.values(LeadStatus).map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
               </select>
              <button onClick={onClose} className="p-2 hover:bg-gray-800 rounded-full transition-colors">
                <X size={20} />
              </button>
            </div>
          </div>

          {/* Main Content Area: Split View */}
          <div className="flex-1 flex overflow-hidden">
            
            {/* Left: Chat History */}
            <div className="flex-1 flex flex-col border-r border-gray-200 min-w-[400px] relative">
              
              {/* Human Mode Banner */}
              {driver.isHumanMode && (
                  <div className="absolute top-0 left-0 right-0 bg-amber-50 border-b border-amber-200 p-2 z-10 flex items-center justify-center gap-2 text-xs font-bold text-amber-800 shadow-sm">
                      <Headset size={14} />
                      Automation Paused. You are in manual control.
                  </div>
              )}

              <div className={`flex-1 overflow-y-auto p-4 bg-gray-50 space-y-4 ${driver.isHumanMode ? 'pt-10' : ''}`}>
                {messages.length > 0 ? (
                    messages.map((msg) => (
                    <div 
                        key={msg.id} 
                        className={`flex ${msg.sender === 'driver' ? 'justify-start' : 'justify-end'}`}
                    >
                        <div 
                        className={`max-w-[80%] rounded-2xl px-4 py-3 shadow-sm ${
                            msg.sender === 'driver' 
                            ? 'bg-white text-gray-900 rounded-tl-none border border-gray-200' 
                            : 'bg-blue-600 text-white rounded-tr-none'
                        }`}
                        >
                        {msg.type === 'image' && msg.imageUrl && (
                            <div className="mb-2 rounded-lg overflow-hidden border border-gray-200/20">
                            <img src={msg.imageUrl} alt="Attachment" className="w-full h-full object-cover max-h-60" />
                            </div>
                        )}
                        {msg.text && <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.text}</p>}
                        <div className={`text-[10px] mt-1 text-right ${msg.sender === 'driver' ? 'text-gray-400' : 'text-blue-200'}`}>
                            {new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                        </div>
                        </div>
                    </div>
                    ))
                ) : (
                    <div className="h-full flex items-center justify-center text-gray-400 text-sm">
                        No messages yet
                    </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Input Area */}
              <div className="p-4 bg-white border-t border-gray-200">
                <div className="flex gap-3">
                  <textarea
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={handleKeyPress}
                    placeholder="Type a message..."
                    className="flex-1 resize-none border border-gray-300 rounded-xl p-3 focus:outline-none focus:ring-2 focus:ring-blue-500 h-20"
                  />
                  <button 
                    onClick={handleSend}
                    disabled={!replyText.trim()}
                    className="self-end bg-black text-white p-3 rounded-xl hover:bg-gray-800 disabled:opacity-50 transition-all"
                  >
                    <Send size={20} />
                  </button>
                </div>
              </div>
            </div>

            {/* Right: Driver Profile & Onboarding */}
            <div className="w-[400px] bg-white flex flex-col overflow-y-auto border-l border-gray-200">
              
              {/* Onboarding Progress Bar */}
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
                
                {/* Qualification Checklist */}
                <section>
                   <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
                     <ShieldCheck size={18} className="text-blue-600" />
                     Qualification Criteria
                   </h3>
                   <div className="space-y-3">
                      <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-100">
                        <span className="text-sm text-gray-600">Valid Driving License</span>
                        <button 
                          onClick={() => handleUpdateDetails({ qualificationChecks: { ...driver.qualificationChecks, hasValidLicense: !driver.qualificationChecks.hasValidLicense } })}
                          className={`p-1 rounded-full ${driver.qualificationChecks.hasValidLicense ? 'text-green-500 bg-green-100' : 'text-gray-300 bg-gray-200'}`}
                        >
                          <CheckCircle size={20} />
                        </button>
                      </div>
                      <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-100">
                        <span className="text-sm text-gray-600">Local Availability</span>
                        <button 
                          onClick={() => handleUpdateDetails({ qualificationChecks: { ...driver.qualificationChecks, isLocallyAvailable: !driver.qualificationChecks.isLocallyAvailable } })}
                          className={`p-1 rounded-full ${driver.qualificationChecks.isLocallyAvailable ? 'text-green-500 bg-green-100' : 'text-gray-300 bg-gray-200'}`}
                        >
                          <CheckCircle size={20} />
                        </button>
                      </div>
                      {/* Overall Status Helper */}
                      <div className="text-xs text-gray-400 mt-2 px-1">
                        * Verify documents manually before marking Qualified.
                      </div>
                   </div>
                </section>

                {/* Vehicle Details */}
                <section>
                   <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
                     <Car size={18} className="text-blue-600" />
                     Vehicle Details
                   </h3>
                   <div className="space-y-3">
                     <div>
                       <label className="text-xs text-gray-500 font-medium mb-1 block">Registration Number</label>
                       <div className="flex gap-2">
                         <input 
                           type="text" 
                           value={driver.vehicleRegistration || ''} 
                           onChange={(e) => handleUpdateDetails({ vehicleRegistration: e.target.value })}
                           placeholder="MH 02 AB 1234"
                           className="flex-1 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                         />
                         <button 
                           onClick={() => onSendMessage('Please provide your vehicle registration number.')}
                           className="text-blue-600 hover:bg-blue-50 p-2 rounded-lg text-xs font-medium"
                           title="Request Info"
                         >
                           Ask
                         </button>
                       </div>
                     </div>
                   </div>
                </section>

                {/* Availability */}
                <section>
                   <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
                     <Clock size={18} className="text-blue-600" />
                     Availability
                   </h3>
                   <div className="space-y-3">
                     <div className="grid grid-cols-3 gap-2">
                        {['Full-time', 'Part-time', 'Weekends'].map((opt) => (
                          <button
                            key={opt}
                            onClick={() => handleUpdateDetails({ availability: opt as any })}
                            className={`px-3 py-2 text-xs font-medium rounded-lg border transition-all ${driver.availability === opt ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'}`}
                          >
                            {opt}
                          </button>
                        ))}
                     </div>
                     <button 
                       onClick={() => onSendMessage('What is your driving availability? (Full-time / Part-time / Weekends)')}
                       className="w-full text-center text-blue-600 hover:bg-blue-50 py-2 rounded-lg text-xs font-medium border border-transparent hover:border-blue-100 transition-colors"
                     >
                       Request Availability Info
                     </button>
                   </div>
                </section>

                {/* Documents */}
                <section>
                   <h3 className="font-semibold text-gray-900 mb-4 text-sm">Documents</h3>
                   {documents.length > 0 ? (
                     <div className="grid grid-cols-2 gap-3">
                       {documents.map((doc, idx) => (
                         <a key={idx} href={doc} target="_blank" rel="noreferrer" className="block relative aspect-video rounded-lg overflow-hidden border border-gray-200 group hover:shadow-md transition-shadow">
                           <img src={doc} alt={`Doc ${idx}`} className="w-full h-full object-cover" />
                           <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white text-xs font-medium">
                             View Document
                           </div>
                         </a>
                       ))}
                     </div>
                   ) : (
                     <div className="text-center py-6 bg-gray-50 rounded-lg border border-dashed border-gray-300 text-gray-400 text-xs">
                       No documents uploaded yet
                     </div>
                   )}
                </section>

                {/* Actions */}
                <div className="pt-4 border-t border-gray-100">
                  <button 
                    onClick={() => {
                      if (driver.qualificationChecks.hasValidLicense) {
                        onUpdateDriver(driver.id, { status: LeadStatus.QUALIFIED });
                      } else {
                        alert("Cannot qualify driver without a valid license check.");
                      }
                    }}
                    className="w-full bg-black text-white py-3 rounded-lg font-medium hover:bg-gray-800 transition-colors flex items-center justify-center gap-2"
                  >
                    <CheckCircle size={18} />
                    Approve & Qualify Driver
                  </button>
                  <button 
                    onClick={() => onUpdateDriver(driver.id, { status: LeadStatus.REJECTED })}
                    className="w-full mt-3 text-red-600 py-3 rounded-lg font-medium hover:bg-red-50 transition-colors flex items-center justify-center gap-2"
                  >
                    <UserX size={18} />
                    Reject Application
                  </button>
                </div>

              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
