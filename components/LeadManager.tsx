
import React, { useState, useMemo } from 'react';
import { Driver, LeadStatus, MessageButton } from '../types';
import { 
  Search, Filter, Send, MessageSquare, CheckCircle, 
  AlertCircle, X, Users, ChevronLeft, ChevronRight, 
  MoreHorizontal, Phone, Mail, FileText, Zap, Paperclip, Cloud, Trash2, Plus, GitBranch,
  Globe, MapPin, CreditCard
} from 'lucide-react';
import { MediaSelectorModal } from './MediaSelectorModal';

interface LeadManagerProps {
  drivers: Driver[];
  onSelectDriver: (driver: Driver) => void;
  onBulkSend: (ids: string[], message: string, mediaUrl?: string, mediaType?: string, buttons?: MessageButton[]) => void;
  onUpdateDriverStatus: (ids: string[], status: LeadStatus) => void;
}

const ITEMS_PER_PAGE = 15;

export const LeadManager: React.FC<LeadManagerProps> = ({ 
  drivers, 
  onSelectDriver, 
  onBulkSend,
  onUpdateDriverStatus
}) => {
  const [activeSection, setActiveSection] = useState<string>('All');
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showBulkCompose, setShowBulkCompose] = useState(false);
  
  // Compose State
  const [bulkMessage, setBulkMessage] = useState('');
  const [selectedMedia, setSelectedMedia] = useState<{url: string, type: 'image' | 'video' | 'document'} | null>(null);
  const [showMediaPicker, setShowMediaPicker] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  
  // Buttons State
  const [buttons, setButtons] = useState<MessageButton[]>([]);

  // --- SECTIONS CONFIG ---
  const sections = [
    { id: 'All', label: 'All Leads', icon: Users, color: 'text-gray-600' },
    { id: LeadStatus.NEW, label: 'New Inquiries', icon: Zap, color: 'text-blue-600' },
    { id: LeadStatus.QUALIFIED, label: 'Qualified', icon: CheckCircle, color: 'text-green-600' },
    { id: LeadStatus.FLAGGED_FOR_REVIEW, label: 'Flagged', icon: AlertCircle, color: 'text-amber-600' },
    { id: LeadStatus.REJECTED, label: 'Rejected', icon: X, color: 'text-red-600' },
    { id: LeadStatus.ONBOARDED, label: 'Onboarded', icon: FileText, color: 'text-purple-600' },
  ];

  // --- FILTERING ---
  const filteredDrivers = useMemo(() => {
    return drivers.filter(d => {
      const matchesSearch = d.name.toLowerCase().includes(searchTerm.toLowerCase()) || d.phoneNumber.includes(searchTerm);
      const matchesSection = activeSection === 'All' || d.status === activeSection;
      return matchesSearch && matchesSection;
    });
  }, [drivers, activeSection, searchTerm]);

  const totalPages = Math.ceil(filteredDrivers.length / ITEMS_PER_PAGE);
  const paginatedDrivers = filteredDrivers.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );

  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) setSelectedIds(filteredDrivers.map(d => d.id));
    else setSelectedIds([]);
  };

  const handleSelectOne = (id: string) => {
    if (selectedIds.includes(id)) setSelectedIds(prev => prev.filter(sid => sid !== id));
    else setSelectedIds(prev => [...prev, id]);
  };

  const executeBulkSend = () => {
    if (!bulkMessage.trim() && !selectedMedia) return;
    onBulkSend(
        selectedIds, 
        bulkMessage, 
        selectedMedia?.url, 
        selectedMedia?.type, 
        buttons.length > 0 ? buttons : undefined
    );
    setShowBulkCompose(false);
    setBulkMessage('');
    setSelectedMedia(null);
    setButtons([]);
    setShowOptions(false);
    setSelectedIds([]);
  };

  const executeBulkStatusUpdate = (status: LeadStatus) => {
      if(window.confirm(`Move ${selectedIds.length} leads to ${status}?`)) {
          onUpdateDriverStatus(selectedIds, status);
          setSelectedIds([]);
      }
  };

  const addButton = () => {
      if (buttons.length < 3) setButtons([...buttons, { type: 'reply', title: 'New Button' }]);
  };

  const updateButton = (index: number, field: keyof MessageButton, value: string) => {
      const newBtns = [...buttons];
      newBtns[index] = { ...newBtns[index], [field]: value };
      setButtons(newBtns);
  };

  const removeButton = (index: number) => {
      setButtons(buttons.filter((_, i) => i !== index));
  };

  return (
    <div className="flex h-[calc(100vh-100px)] bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
      
      {/* SIDEBAR */}
      <div className="w-64 bg-gray-50 border-r border-gray-200 flex flex-col shrink-0">
        <div className="p-5 border-b border-gray-200">
           <h2 className="font-bold text-gray-800">Lead Sections</h2>
           <p className="text-xs text-gray-500 mt-1">Organize & Broadcast</p>
        </div>
        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {sections.map(section => {
            const count = section.id === 'All' ? drivers.length : drivers.filter(d => d.status === section.id).length;
            const Icon = section.icon;
            const isActive = activeSection === section.id;
            
            return (
              <button
                key={section.id}
                onClick={() => { setActiveSection(section.id); setCurrentPage(1); setSelectedIds([]); }}
                className={`w-full flex items-center justify-between px-3 py-3 rounded-xl text-sm font-medium transition-all ${
                  isActive ? 'bg-white shadow-sm text-gray-900 border border-gray-200' : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Icon size={18} className={isActive ? section.color : 'text-gray-400'} />
                  {section.label}
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${isActive ? 'bg-gray-100 text-gray-900 font-bold' : 'bg-gray-200/50 text-gray-500'}`}>{count}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* MAIN CONTENT */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="p-4 border-b border-gray-200 flex items-center justify-between gap-4">
           <div className="flex items-center gap-2 bg-gray-50 px-3 py-2.5 rounded-xl border border-gray-200 flex-1 max-w-md focus-within:ring-2 focus-within:ring-blue-500/20 transition-all">
              <Search size={18} className="text-gray-400" />
              <input type="text" placeholder="Search by name or phone..." className="bg-transparent border-none outline-none w-full text-sm" value={searchTerm} onChange={(e) => { setSearchTerm(e.target.value); setCurrentPage(1); }} />
           </div>
           <div className="flex items-center gap-2 text-sm text-gray-500"><span>{filteredDrivers.length} Leads found</span></div>
        </div>

        <div className="bg-gray-50/50 border-b border-gray-200 flex items-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">
           <div className="w-10">
              <input type="checkbox" className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer" checked={selectedIds.length > 0 && selectedIds.length === filteredDrivers.length} onChange={handleSelectAll} />
           </div>
           <div className="flex-1">Driver Details</div>
           <div className="w-32 hidden md:block">Source</div>
           <div className="w-32">Status</div>
           <div className="w-40 text-right">Actions</div>
        </div>

        <div className="flex-1 overflow-y-auto">
           {paginatedDrivers.map(driver => (
             <div key={driver.id} onClick={() => onSelectDriver(driver)} className={`group flex items-center px-6 py-4 border-b border-gray-100 hover:bg-blue-50/30 transition-colors cursor-pointer ${selectedIds.includes(driver.id) ? 'bg-blue-50/50' : ''}`}>
                <div className="w-10" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer" checked={selectedIds.includes(driver.id)} onChange={() => handleSelectOne(driver.id)} />
                </div>
                <div className="flex-1 min-w-0 pr-4">
                   <div className="flex items-center gap-2">
                       <span className="font-bold text-gray-900 truncate">{driver.name}</span>
                       {driver.isBotActive && <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" title="Bot Active"></span>}
                   </div>
                   <div className="text-xs text-gray-500 flex items-center gap-3 mt-1">
                      <span className="flex items-center gap-1"><Phone size={10} /> {driver.phoneNumber}</span>
                      <span className="hidden sm:inline text-gray-300">|</span>
                      <span className="hidden sm:inline truncate max-w-[200px]">{driver.lastMessage}</span>
                   </div>
                </div>
                <div className="w-32 hidden md:flex items-center">
                    <span className={`text-[10px] px-2 py-1 rounded-md font-medium border ${driver.source === 'Meta Ad' ? 'bg-blue-50 text-blue-700 border-blue-100' : 'bg-gray-50 text-gray-600 border-gray-100'}`}>{driver.source}</span>
                </div>
                <div className="w-32">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${driver.status === LeadStatus.NEW ? 'bg-blue-100 text-blue-800 border-blue-200' : driver.status === LeadStatus.QUALIFIED ? 'bg-green-100 text-green-800 border-green-200' : 'bg-gray-100 text-gray-800 border-gray-200'}`}>{driver.status}</span>
                </div>
                <div className="w-40 flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={(e) => { e.stopPropagation(); onSelectDriver(driver); }} className="p-2 text-blue-600 hover:bg-blue-100 rounded-lg transition-colors"><MessageSquare size={16} /></button>
                </div>
             </div>
           ))}
        </div>

        {totalPages > 1 && (
            <div className="p-4 border-t border-gray-200 flex items-center justify-between bg-gray-50/50">
                <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="p-2 rounded-lg hover:bg-gray-200 disabled:opacity-50"><ChevronLeft size={18} /></button>
                <span className="text-xs font-bold text-gray-500">Page {currentPage} of {totalPages}</span>
                <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="p-2 rounded-lg hover:bg-gray-200 disabled:opacity-50"><ChevronRight size={18} /></button>
            </div>
        )}
      </div>

      {/* FLOATING ACTION BAR */}
      {selectedIds.length > 0 && (
        <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 bg-black text-white px-6 py-3 rounded-full shadow-2xl z-20 flex items-center gap-6 animate-in slide-in-from-bottom-5">
           <span className="text-sm font-bold flex items-center gap-2"><CheckCircle size={16} className="text-green-400" /> {selectedIds.length} Selected</span>
           <div className="h-4 w-px bg-gray-700"></div>
           <div className="flex items-center gap-2">
              <button onClick={() => setShowBulkCompose(true)} className="hover:text-blue-300 transition-colors text-sm font-medium flex items-center gap-2"><Send size={16} /> Broadcast</button>
              <button onClick={() => executeBulkStatusUpdate(LeadStatus.QUALIFIED)} className="hover:text-green-300 transition-colors text-sm font-medium ml-4">Mark Qualified</button>
              <button onClick={() => setSelectedIds([])} className="ml-4 p-1 hover:bg-gray-800 rounded-full"><X size={14} /></button>
           </div>
        </div>
      )}

      {/* BULK COMPOSE MODAL */}
      {showBulkCompose && (
          <div className="absolute inset-0 z-30 bg-black/20 backdrop-blur-sm flex items-end justify-end">
              <div className="w-[480px] bg-white h-full shadow-2xl border-l border-gray-200 flex flex-col animate-in slide-in-from-right duration-300">
                  <div className="p-4 border-b border-gray-100 flex items-center justify-between bg-gray-50">
                      <h3 className="font-bold text-gray-800 flex items-center gap-2"><Send size={16} className="text-blue-600" /> Bulk Broadcast</h3>
                      <button onClick={() => setShowBulkCompose(false)} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
                  </div>
                  
                  <div className="p-6 flex-1 flex flex-col overflow-y-auto">
                      <div className="bg-blue-50 p-3 rounded-lg border border-blue-100 mb-4 text-xs text-blue-800">
                          <p>Sending to <strong>{selectedIds.length}</strong> recipients in <strong>{activeSection}</strong>.</p>
                      </div>
                      
                      <div className="space-y-4">
                          <div>
                              <label className="text-xs font-bold text-gray-500 uppercase mb-2 block">Message</label>
                              <textarea value={bulkMessage} onChange={(e) => setBulkMessage(e.target.value)} className="w-full p-4 bg-gray-50 border border-gray-200 rounded-xl resize-none outline-none focus:ring-2 focus:ring-blue-500 min-h-[120px] text-sm" placeholder="Type your message here..." />
                          </div>

                          {/* Attachment */}
                          <div>
                              <div className="flex items-center justify-between mb-2">
                                  <label className="text-xs font-bold text-gray-500 uppercase">Header Attachment</label>
                                  {selectedMedia && (
                                      <button onClick={() => setSelectedMedia(null)} className="text-red-500 text-xs hover:underline flex items-center gap-1"><Trash2 size={12} /> Remove</button>
                                  )}
                              </div>
                              {selectedMedia ? (
                                  <div className="bg-gray-100 rounded-lg p-3 border border-gray-200 flex items-center gap-3">
                                      {selectedMedia.type === 'image' ? <div className="w-10 h-10 bg-blue-100 rounded flex items-center justify-center text-blue-500"><Cloud size={20} /></div> :
                                       <div className="w-10 h-10 bg-purple-100 rounded flex items-center justify-center text-purple-500"><Zap size={20} /></div>}
                                      <div className="flex-1 min-w-0">
                                          <div className="text-xs font-bold truncate">S3 Media Asset</div>
                                          <div className="text-[10px] text-gray-500 uppercase">{selectedMedia.type}</div>
                                      </div>
                                  </div>
                              ) : (
                                  <button onClick={() => setShowMediaPicker(true)} className="w-full py-3 border-2 border-dashed border-gray-200 rounded-xl text-sm font-medium text-gray-500 hover:text-blue-600 hover:border-blue-300 hover:bg-blue-50 transition-all flex items-center justify-center gap-2">
                                      <Paperclip size={16} /> Attach Media
                                  </button>
                              )}
                          </div>

                          {/* Buttons */}
                          <div>
                              <div className="flex items-center justify-between mb-2">
                                  <label className="text-xs font-bold text-gray-500 uppercase flex items-center gap-2"><CreditCard size={14} /> Buttons</label>
                                  <button onClick={addButton} className="text-blue-600 text-xs hover:underline font-bold">+ Add Button</button>
                              </div>

                              <div className="space-y-2">
                                  {buttons.map((btn, idx) => (
                                      <div key={idx} className="bg-gray-50 p-2 rounded-lg border border-gray-200 space-y-2">
                                          <div className="flex gap-2">
                                              <select value={btn.type} onChange={(e) => updateButton(idx, 'type', e.target.value as any)} className="bg-white border border-gray-200 text-xs rounded p-1 w-24 outline-none">
                                                  <option value="reply">Reply</option>
                                                  <option value="url">Link</option>
                                                  <option value="location">Location</option>
                                                  <option value="phone">Call</option>
                                              </select>
                                              <input value={btn.title} onChange={(e) => updateButton(idx, 'title', e.target.value)} className="flex-1 bg-white border border-gray-200 text-xs rounded p-1 outline-none" placeholder="Label" />
                                              <button onClick={() => removeButton(idx)} className="text-red-400 hover:text-red-600"><X size={14} /></button>
                                          </div>
                                          {btn.type !== 'reply' && btn.type !== 'location' && (
                                              <input value={btn.payload || ''} onChange={(e) => updateButton(idx, 'payload', e.target.value)} className="w-full bg-white border border-gray-200 text-xs rounded p-1 outline-none" placeholder={btn.type === 'url' ? 'https://...' : '+1234...'} />
                                          )}
                                      </div>
                                  ))}
                              </div>
                          </div>
                      </div>
                  </div>

                  <div className="p-6 border-t border-gray-100 bg-gray-50">
                      <button onClick={executeBulkSend} disabled={(!bulkMessage.trim() && !selectedMedia)} className="w-full bg-blue-600 text-white py-3.5 rounded-xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                          <Send size={18} /> Send Broadcast
                      </button>
                  </div>
              </div>
          </div>
      )}
      
      <MediaSelectorModal isOpen={showMediaPicker} onClose={() => setShowMediaPicker(false)} onSelect={(url, type) => { setSelectedMedia({ url, type }); setShowMediaPicker(false); }} allowedType="All" />
    </div>
  );
};
