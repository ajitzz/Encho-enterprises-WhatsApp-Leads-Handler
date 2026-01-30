
import React, { useState, useMemo } from 'react';
import { Driver, LeadStatus, MessageButton } from '../types';
import { 
  Search, Send, MessageSquare, CheckCircle, AlertCircle, X, Users, ChevronLeft, ChevronRight, 
  Phone, Zap, Paperclip, Cloud, Trash2, CreditCard, LayoutTemplate, Clock
} from 'lucide-react';
import { MediaSelectorModal } from './MediaSelectorModal';
import { liveApiService } from '../services/liveApiService'; 

interface LeadManagerProps {
  drivers: Driver[];
  onSelectDriver: (driver: Driver) => void;
  onBulkSend: (ids: string[], message: string, mediaUrl?: string, mediaType?: string, options?: string[], templateName?: string, scheduledTime?: number) => void;
  onUpdateDriverStatus: (ids: string[], status: LeadStatus) => void;
}

const ITEMS_PER_PAGE = 15;
const MIN_SCHEDULE_LEAD_MINUTES = 5;
const MAX_BROADCAST_RECIPIENTS = 5000;
const MAX_BUTTONS = 3;

export const LeadManager: React.FC<LeadManagerProps> = ({ 
  drivers, onSelectDriver, onBulkSend, onUpdateDriverStatus
}) => {
  const [activeSection, setActiveSection] = useState<string>('All');
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showBulkCompose, setShowBulkCompose] = useState(false);
  
  const [bulkMessage, setBulkMessage] = useState('');
  const [selectedMedia, setSelectedMedia] = useState<{url: string, type: 'image' | 'video' | 'document'} | null>(null);
  const [showMediaPicker, setShowMediaPicker] = useState(false);
  const [templateName, setTemplateName] = useState('');
  
  const [isScheduled, setIsScheduled] = useState(false);
  const [scheduleTime, setScheduleTime] = useState('');
  const [buttons, setButtons] = useState<MessageButton[]>([]);
  const [campaignName, setCampaignName] = useState('');
  const [priority, setPriority] = useState<'standard' | 'high'>('standard');
  const [rateLimit, setRateLimit] = useState(60);
  const [batchSize, setBatchSize] = useState(100);
  const [windowStart, setWindowStart] = useState('08:00');
  const [windowEnd, setWindowEnd] = useState('20:00');
  const [complianceConfirmed, setComplianceConfirmed] = useState(false);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const sections = [
    { id: 'All', label: 'All Leads', icon: Users, color: 'text-gray-600' },
    { id: LeadStatus.NEW, label: 'New Inquiries', icon: Zap, color: 'text-blue-600' },
    { id: LeadStatus.QUALIFIED, label: 'Qualified', icon: CheckCircle, color: 'text-green-600' },
    { id: LeadStatus.FLAGGED_FOR_REVIEW, label: 'Flagged', icon: AlertCircle, color: 'text-amber-600' },
    { id: LeadStatus.REJECTED, label: 'Rejected', icon: X, color: 'text-red-600' },
  ];

  const filteredDrivers = useMemo(() => {
    return drivers.filter(d => {
      const matchesSearch = d.name.toLowerCase().includes(searchTerm.toLowerCase()) || d.phoneNumber.includes(searchTerm);
      const matchesSection = activeSection === 'All' || d.status === activeSection;
      return matchesSearch && matchesSection;
    });
  }, [drivers, activeSection, searchTerm]);

  const paginatedDrivers = filteredDrivers.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);
  const totalPages = Math.ceil(filteredDrivers.length / ITEMS_PER_PAGE);

  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) setSelectedIds(filteredDrivers.map(d => d.id));
    else setSelectedIds([]);
  };

  const handleSelectOne = (id: string) => {
    if (selectedIds.includes(id)) setSelectedIds(prev => prev.filter(sid => sid !== id));
    else setSelectedIds(prev => [...prev, id]);
  };

  const scheduleTimestamp = useMemo(() => {
    if (!isScheduled || !scheduleTime) return null;
    const value = new Date(scheduleTime).getTime();
    return Number.isNaN(value) ? null : value;
  }, [isScheduled, scheduleTime]);

  const scheduleError = useMemo(() => {
    if (!isScheduled) return '';
    if (!scheduleTimestamp) return 'Schedule time is required.';
    const minLeadMs = MIN_SCHEDULE_LEAD_MINUTES * 60 * 1000;
    if (scheduleTimestamp <= Date.now() + minLeadMs) {
      return `Choose a time at least ${MIN_SCHEDULE_LEAD_MINUTES} minutes in the future.`;
    }
    return '';
  }, [isScheduled, scheduleTimestamp]);

  const broadcastEstimate = useMemo(() => {
    const recipients = selectedIds.length;
    if (recipients === 0) return '—';
    const effectiveRate = Math.max(1, rateLimit);
    const minutes = Math.ceil(recipients / effectiveRate);
    return `${minutes} min @ ${effectiveRate}/min`;
  }, [selectedIds.length, rateLimit]);

  const executeBulkSend = async () => {
    // BLOCKED PHRASES
    if (/replace this|sample message|type your message/i.test(bulkMessage)) {
        alert("Please remove placeholder text.");
        return;
    }

    if (!bulkMessage.trim() && !selectedMedia && !templateName) return;
    if (selectedIds.length > MAX_BROADCAST_RECIPIENTS) {
        alert(`Broadcast cap exceeded. Max ${MAX_BROADCAST_RECIPIENTS} recipients per campaign.`);
        return;
    }
    if (isScheduled && scheduleError) {
        alert(scheduleError);
        return;
    }
    if (!complianceConfirmed) {
        alert("Please confirm opt-in compliance before broadcasting.");
        return;
    }
    
    const timestamp = isScheduled && scheduleTimestamp ? scheduleTimestamp : Date.now();
    try {
        await liveApiService.scheduleMessage(selectedIds, {
            text: bulkMessage,
            mediaUrl: selectedMedia?.url,
            mediaType: selectedMedia?.type,
            buttons: buttons.length > 0 ? (buttons as any) : undefined,
            templateName: templateName || undefined,
            metadata: {
              campaignName: campaignName || `Broadcast ${new Date().toLocaleDateString()}`,
              priority,
              rateLimitPerMinute: rateLimit,
              batchSize,
              windowStart,
              windowEnd,
              timezone,
              complianceConfirmed
            }
        }, timestamp);
        onBulkSend(selectedIds, bulkMessage, selectedMedia?.url, selectedMedia?.type, buttons as any, templateName, timestamp);
    } catch (e: any) { alert(`Failed: ${e.message}`); return; }

    setShowBulkCompose(false);
    setBulkMessage(''); setTemplateName(''); setSelectedMedia(null); setButtons([]); setIsScheduled(false); setScheduleTime(''); setSelectedIds([]);
    setCampaignName(''); setPriority('standard'); setRateLimit(60); setBatchSize(100); setWindowStart('08:00'); setWindowEnd('20:00'); setComplianceConfirmed(false);
  };

  return (
    <div className="flex h-[calc(100vh-100px)] bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
      <div className="w-64 bg-gray-50 border-r border-gray-200 flex flex-col shrink-0">
        <div className="p-5 border-b border-gray-200"><h2 className="font-bold text-gray-800">Lead Sections</h2></div>
        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {sections.map(section => (
              <button key={section.id} onClick={() => { setActiveSection(section.id); setCurrentPage(1); setSelectedIds([]); }} className={`w-full flex items-center justify-between px-3 py-3 rounded-xl text-sm font-medium transition-all ${activeSection === section.id ? 'bg-white shadow-sm text-gray-900 border border-gray-200' : 'text-gray-500 hover:bg-gray-100'}`}>
                <div className="flex items-center gap-3"><section.icon size={18} className={activeSection === section.id ? section.color : 'text-gray-400'} />{section.label}</div>
                <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 font-bold">{section.id === 'All' ? drivers.length : drivers.filter(d => d.status === section.id).length}</span>
              </button>
          ))}
        </nav>
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        <div className="p-4 border-b border-gray-200 flex items-center gap-4">
           <div className="flex items-center gap-2 bg-gray-50 px-3 py-2.5 rounded-xl border border-gray-200 flex-1 max-w-md"><Search size={18} className="text-gray-400" /><input type="text" placeholder="Search..." className="bg-transparent border-none outline-none w-full text-sm" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} /></div>
        </div>
        <div className="bg-gray-50/50 border-b border-gray-200 flex items-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">
           <div className="w-10"><input type="checkbox" checked={selectedIds.length > 0 && selectedIds.length === filteredDrivers.length} onChange={handleSelectAll} /></div>
           <div className="flex-1">Driver Details</div>
           <div className="w-32">Status</div>
        </div>
        <div className="flex-1 overflow-y-auto">
           {paginatedDrivers.map(driver => (
             <div key={driver.id} onClick={() => onSelectDriver(driver)} className={`flex items-center px-6 py-4 border-b border-gray-100 hover:bg-blue-50/30 cursor-pointer ${selectedIds.includes(driver.id) ? 'bg-blue-50/50' : ''}`}>
                <div className="w-10" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selectedIds.includes(driver.id)} onChange={() => handleSelectOne(driver.id)} /></div>
                <div className="flex-1 min-w-0 pr-4">
                   <div className="font-bold text-gray-900 truncate">{driver.name}</div>
                   <div className="text-xs text-gray-500 flex items-center gap-3 mt-1"><span className="flex items-center gap-1"><Phone size={10} /> {driver.phoneNumber}</span></div>
                </div>
                <div className="w-32"><span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase border bg-gray-100 text-gray-800">{driver.status}</span></div>
             </div>
           ))}
        </div>
        {totalPages > 1 && <div className="p-4 border-t border-gray-200 flex justify-between"><button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1}><ChevronLeft size={18} /></button><span className="text-xs font-bold text-gray-500">Page {currentPage} of {totalPages}</span><button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}><ChevronRight size={18} /></button></div>}
      </div>

      {selectedIds.length > 0 && (
        <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 bg-black text-white px-6 py-3 rounded-full shadow-2xl z-20 flex items-center gap-6 animate-in slide-in-from-bottom-5">
           <span className="text-sm font-bold flex items-center gap-2"><CheckCircle size={16} className="text-green-400" /> {selectedIds.length} Selected</span>
           <button onClick={() => setShowBulkCompose(true)} className="hover:text-blue-300 transition-colors text-sm font-medium flex items-center gap-2"><Send size={16} /> Broadcast</button>
           <button onClick={() => setSelectedIds([])} className="ml-4 p-1 hover:bg-gray-800 rounded-full"><X size={14} /></button>
        </div>
      )}

      {showBulkCompose && (
          <div className="absolute inset-0 z-30 bg-black/20 backdrop-blur-sm flex items-end justify-end">
              <div className="w-[480px] bg-white h-full shadow-2xl border-l border-gray-200 flex flex-col animate-in slide-in-from-right duration-300">
                  <div className="p-4 border-b border-gray-100 flex items-center justify-between bg-gray-50">
                      <h3 className="font-bold text-gray-800 flex items-center gap-2"><Send size={16} className="text-blue-600" /> Bulk Broadcast</h3>
                      <button onClick={() => setShowBulkCompose(false)}><X size={20} className="text-gray-400" /></button>
                  </div>
                  <div className="p-6 flex-1 flex flex-col overflow-y-auto space-y-4">
                      <div className="bg-blue-50 p-3 rounded-lg border border-blue-100 text-xs text-blue-800 space-y-2">
                        <div className="flex items-center justify-between">
                          <span>Recipients</span>
                          <strong>{selectedIds.length}</strong>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>Estimated delivery</span>
                          <strong>{broadcastEstimate}</strong>
                        </div>
                        <div className="text-[10px] text-blue-700">Timezone: {timezone}</div>
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-bold text-gray-600">Campaign Name</label>
                        <input value={campaignName} onChange={(e) => setCampaignName(e.target.value)} className="w-full p-2 border rounded text-sm" placeholder="e.g. April Fleet Push" />
                      </div>
                      <div className="p-3 rounded-lg border bg-gray-50 space-y-2">
                          <div className="flex items-center justify-between">
                            <label className="text-xs font-bold text-gray-600 flex items-center gap-2"><Clock size={14} /> Schedule</label>
                            <input type="checkbox" checked={isScheduled} onChange={(e) => setIsScheduled(e.target.checked)} />
                          </div>
                          {isScheduled && (
                            <>
                              <input type="datetime-local" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} className="w-full p-2 border rounded text-sm" />
                              {scheduleError && <div className="text-[10px] text-red-600 font-semibold">{scheduleError}</div>}
                            </>
                          )}
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="text-[10px] text-gray-500 font-semibold">Window Start</label>
                              <input type="time" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} className="w-full p-2 border rounded text-sm" />
                            </div>
                            <div>
                              <label className="text-[10px] text-gray-500 font-semibold">Window End</label>
                              <input type="time" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} className="w-full p-2 border rounded text-sm" />
                            </div>
                          </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                          <label className="text-xs font-bold text-gray-600">Priority</label>
                          <select value={priority} onChange={(e) => setPriority(e.target.value as 'standard' | 'high')} className="w-full p-2 border rounded text-sm">
                            <option value="standard">Standard</option>
                            <option value="high">High</option>
                          </select>
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs font-bold text-gray-600">Rate Limit / min</label>
                          <input type="number" min={1} value={rateLimit} onChange={(e) => setRateLimit(Math.max(1, Number(e.target.value)))} className="w-full p-2 border rounded text-sm" />
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs font-bold text-gray-600">Batch Size</label>
                          <input type="number" min={1} value={batchSize} onChange={(e) => setBatchSize(Math.max(1, Number(e.target.value)))} className="w-full p-2 border rounded text-sm" />
                        </div>
                      </div>
                      <div className="space-y-3">
                        <label className="text-xs font-bold text-gray-600">Message</label>
                        <textarea value={bulkMessage} onChange={(e) => setBulkMessage(e.target.value)} className="w-full p-4 bg-gray-50 border border-gray-200 rounded-xl resize-none min-h-[120px] text-sm" placeholder="Type message..." />
                        <div className="flex flex-wrap gap-2 text-[10px] text-gray-500 items-center">
                          <span>{bulkMessage.trim().length} characters</span>
                          <span className="h-1 w-1 rounded-full bg-gray-300" />
                          <span>{buttons.length}/{MAX_BUTTONS} buttons</span>
                          {selectedMedia && (
                            <>
                              <span className="h-1 w-1 rounded-full bg-gray-300" />
                              <span className="text-blue-600 font-semibold">Media: {selectedMedia.type}</span>
                            </>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => setShowMediaPicker(true)} className="flex items-center gap-2 text-xs font-semibold px-3 py-2 border rounded-lg hover:bg-gray-50">
                            <Paperclip size={12} /> Attach Media
                          </button>
                          <button onClick={() => setSelectedMedia(null)} className="text-xs font-semibold px-3 py-2 border rounded-lg hover:bg-gray-50">
                            Clear Media
                          </button>
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs font-bold text-gray-600">Template Name (Optional)</label>
                          <input value={templateName} onChange={(e) => setTemplateName(e.target.value)} className="w-full p-2 border rounded text-sm" placeholder="e.g. lead_followup_v1" />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-bold text-gray-600">Quick Reply Buttons</label>
                        <div className="space-y-2">
                          {buttons.map((btn, index) => (
                            <div key={btn.id || index} className="flex items-center gap-2">
                              <input
                                value={btn.title}
                                onChange={(e) => {
                                  const next = [...buttons];
                                  next[index] = { ...next[index], title: e.target.value };
                                  setButtons(next);
                                }}
                                className="flex-1 p-2 border rounded text-sm"
                                placeholder={`Button ${index + 1}`}
                              />
                              <button onClick={() => setButtons(buttons.filter((_, idx) => idx !== index))} className="p-1 text-red-500">
                                <Trash2 size={14} />
                              </button>
                            </div>
                          ))}
                          {buttons.length < MAX_BUTTONS && (
                            <button
                              onClick={() => setButtons([...buttons, { type: 'reply', title: `Option ${buttons.length + 1}`, id: Date.now().toString() }])}
                              className="text-xs text-blue-600 font-semibold"
                            >
                              + Add button
                            </button>
                          )}
                        </div>
                      </div>
                      <label className="flex items-center gap-2 text-xs text-gray-600 font-semibold">
                        <input type="checkbox" checked={complianceConfirmed} onChange={(e) => setComplianceConfirmed(e.target.checked)} />
                        I confirm recipients have opted in and content meets compliance requirements.
                      </label>
                  </div>
                  <div className="p-6 border-t border-gray-100 bg-gray-50">
                      <button
                        onClick={executeBulkSend}
                        disabled={(!bulkMessage.trim() && !selectedMedia && !templateName) || !!scheduleError || !complianceConfirmed}
                        className="w-full bg-blue-600 text-white py-3.5 rounded-xl font-bold hover:bg-blue-700 disabled:opacity-50"
                      >
                        {isScheduled ? 'Schedule Broadcast' : 'Send Broadcast'}
                      </button>
                  </div>
              </div>
          </div>
      )}
      <MediaSelectorModal isOpen={showMediaPicker} onClose={() => setShowMediaPicker(false)} onSelect={(url, type) => { setSelectedMedia({ url, type }); setShowMediaPicker(false); }} allowedType="All" />
    </div>
  );
};
