
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

  const executeBulkSend = async () => {
    // BLOCKED PHRASES
    if (/replace this|sample message|type your message/i.test(bulkMessage)) {
        alert("Please remove placeholder text.");
        return;
    }

    if (!bulkMessage.trim() && !selectedMedia && !templateName) return;

    if (isScheduled) {
        if (!scheduleTime) { alert("Please select a schedule time."); return; }
        const scheduledTimestamp = Date.parse(scheduleTime);
        if (Number.isNaN(scheduledTimestamp)) { alert("Please select a valid date and time."); return; }
        if (scheduledTimestamp <= Date.now()) { alert("Please select a future time."); return; }
    }

    const timestamp = isScheduled && scheduleTime ? Date.parse(scheduleTime) : Date.now();
    try {
        await liveApiService.scheduleMessage(selectedIds, {
            text: bulkMessage,
            mediaUrl: selectedMedia?.url,
            mediaType: selectedMedia?.type,
            buttons: buttons.length > 0 ? (buttons as any) : undefined,
            templateName: templateName || undefined
        }, timestamp);
        onBulkSend(selectedIds, bulkMessage, selectedMedia?.url, selectedMedia?.type, buttons as any, templateName, timestamp);
    } catch (e: any) { alert(`Failed: ${e.message}`); return; }

    setShowBulkCompose(false);
    setBulkMessage(''); setTemplateName(''); setSelectedMedia(null); setButtons([]); setIsScheduled(false); setScheduleTime(''); setSelectedIds([]);
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
                      <div className="bg-blue-50 p-3 rounded-lg border border-blue-100 text-xs text-blue-800">Sending to <strong>{selectedIds.length}</strong> recipients.</div>
                      <div className="p-3 rounded-lg border bg-gray-50">
                          <label className="text-xs font-bold text-gray-600 flex items-center gap-2"><Clock size={14} /> Schedule</label>
                          <input type="checkbox" checked={isScheduled} onChange={(e) => setIsScheduled(e.target.checked)} className="ml-2" />
                          {isScheduled && <input type="datetime-local" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} className="w-full mt-2 p-2 border rounded text-sm" />}
                      </div>
                      <textarea value={bulkMessage} onChange={(e) => setBulkMessage(e.target.value)} className="w-full p-4 bg-gray-50 border border-gray-200 rounded-xl resize-none min-h-[120px] text-sm" placeholder="Type message..." />
                  </div>
                  <div className="p-6 border-t border-gray-100 bg-gray-50">
                      <button onClick={executeBulkSend} disabled={(!bulkMessage.trim() && !selectedMedia && !templateName)} className="w-full bg-blue-600 text-white py-3.5 rounded-xl font-bold hover:bg-blue-700 disabled:opacity-50">Send Broadcast</button>
                  </div>
              </div>
          </div>
      )}
      <MediaSelectorModal isOpen={showMediaPicker} onClose={() => setShowMediaPicker(false)} onSelect={(url, type) => { setSelectedMedia({ url, type }); setShowMediaPicker(false); }} allowedType="All" />
    </div>
  );
};
