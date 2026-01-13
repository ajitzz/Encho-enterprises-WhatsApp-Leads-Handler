
import React, { useState, useMemo } from 'react';
import { Driver, LeadStatus } from '../types';
import { 
  Search, Filter, Send, MessageSquare, CheckCircle, 
  AlertCircle, X, Users, ChevronLeft, ChevronRight, 
  MoreHorizontal, Phone, Mail, FileText, Zap
} from 'lucide-react';

interface LeadManagerProps {
  drivers: Driver[];
  onSelectDriver: (driver: Driver) => void;
  onBulkSend: (ids: string[], message: string) => void;
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
  const [bulkMessage, setBulkMessage] = useState('');

  // --- SECTIONS CONFIG ---
  const sections = [
    { id: 'All', label: 'All Leads', icon: Users, color: 'text-gray-600' },
    { id: LeadStatus.NEW, label: 'New Inquiries', icon: Zap, color: 'text-blue-600' },
    { id: LeadStatus.QUALIFIED, label: 'Qualified', icon: CheckCircle, color: 'text-green-600' },
    { id: LeadStatus.FLAGGED_FOR_REVIEW, label: 'Flagged', icon: AlertCircle, color: 'text-amber-600' },
    { id: LeadStatus.REJECTED, label: 'Rejected', icon: X, color: 'text-red-600' },
    { id: LeadStatus.ONBOARDED, label: 'Onboarded', icon: FileText, color: 'text-purple-600' },
  ];

  // --- FILTERING & PAGINATION ---
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

  // --- HANDLERS ---
  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      // Select ONLY what is visible or all in filter? 
      // For bulk actions on 10k items, usually we select all in filter.
      // But for safety, let's select all currently filtered.
      setSelectedIds(filteredDrivers.map(d => d.id));
    } else {
      setSelectedIds([]);
    }
  };

  const handleSelectOne = (id: string) => {
    if (selectedIds.includes(id)) {
      setSelectedIds(prev => prev.filter(sid => sid !== id));
    } else {
      setSelectedIds(prev => [...prev, id]);
    }
  };

  const executeBulkSend = () => {
    if (!bulkMessage.trim()) return;
    onBulkSend(selectedIds, bulkMessage);
    setShowBulkCompose(false);
    setBulkMessage('');
    setSelectedIds([]);
  };

  const executeBulkStatusUpdate = (status: LeadStatus) => {
      if(window.confirm(`Move ${selectedIds.length} leads to ${status}?`)) {
          onUpdateDriverStatus(selectedIds, status);
          setSelectedIds([]);
      }
  };

  return (
    <div className="flex h-[calc(100vh-100px)] bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
      
      {/* LEFT SIDEBAR: SECTIONS */}
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
                  isActive 
                    ? 'bg-white shadow-sm text-gray-900 border border-gray-200' 
                    : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Icon size={18} className={isActive ? section.color : 'text-gray-400'} />
                  {section.label}
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${isActive ? 'bg-gray-100 text-gray-900 font-bold' : 'bg-gray-200/50 text-gray-500'}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* CENTER: MAIN LIST */}
      <div className="flex-1 flex flex-col min-w-0">
        
        {/* Toolbar */}
        <div className="p-4 border-b border-gray-200 flex items-center justify-between gap-4">
           <div className="flex items-center gap-2 bg-gray-50 px-3 py-2.5 rounded-xl border border-gray-200 flex-1 max-w-md focus-within:ring-2 focus-within:ring-blue-500/20 transition-all">
              <Search size={18} className="text-gray-400" />
              <input 
                type="text" 
                placeholder="Search by name or phone..." 
                className="bg-transparent border-none outline-none w-full text-sm"
                value={searchTerm}
                onChange={(e) => { setSearchTerm(e.target.value); setCurrentPage(1); }}
              />
           </div>
           
           <div className="flex items-center gap-2 text-sm text-gray-500">
              <span>{filteredDrivers.length} Leads found</span>
           </div>
        </div>

        {/* Table Header */}
        <div className="bg-gray-50/50 border-b border-gray-200 flex items-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">
           <div className="w-10">
              <input 
                  type="checkbox" 
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                  checked={selectedIds.length > 0 && selectedIds.length === filteredDrivers.length}
                  onChange={handleSelectAll}
              />
           </div>
           <div className="flex-1">Driver Details</div>
           <div className="w-32 hidden md:block">Source</div>
           <div className="w-32">Status</div>
           <div className="w-40 text-right">Actions</div>
        </div>

        {/* List Body */}
        <div className="flex-1 overflow-y-auto">
           {paginatedDrivers.map(driver => (
             <div 
               key={driver.id}
               onClick={() => onSelectDriver(driver)}
               className={`group flex items-center px-6 py-4 border-b border-gray-100 hover:bg-blue-50/30 transition-colors cursor-pointer ${selectedIds.includes(driver.id) ? 'bg-blue-50/50' : ''}`}
             >
                <div className="w-10" onClick={(e) => e.stopPropagation()}>
                    <input 
                      type="checkbox" 
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                      checked={selectedIds.includes(driver.id)}
                      onChange={() => handleSelectOne(driver.id)}
                    />
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
                    <span className={`text-[10px] px-2 py-1 rounded-md font-medium border ${driver.source === 'Meta Ad' ? 'bg-blue-50 text-blue-700 border-blue-100' : 'bg-gray-50 text-gray-600 border-gray-100'}`}>
                        {driver.source}
                    </span>
                </div>
                <div className="w-32">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${
                        driver.status === LeadStatus.NEW ? 'bg-blue-100 text-blue-800 border-blue-200' :
                        driver.status === LeadStatus.QUALIFIED ? 'bg-green-100 text-green-800 border-green-200' :
                        'bg-gray-100 text-gray-800 border-gray-200'
                    }`}>
                        {driver.status}
                    </span>
                </div>
                <div className="w-40 flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button 
                        onClick={(e) => { e.stopPropagation(); onSelectDriver(driver); }}
                        className="p-2 text-blue-600 hover:bg-blue-100 rounded-lg transition-colors"
                        title="Chat"
                    >
                        <MessageSquare size={16} />
                    </button>
                    <button className="p-2 text-gray-400 hover:bg-gray-100 rounded-lg transition-colors">
                        <MoreHorizontal size={16} />
                    </button>
                </div>
             </div>
           ))}
           
           {filteredDrivers.length === 0 && (
             <div className="flex flex-col items-center justify-center h-64 text-gray-400">
               <Search size={48} className="mb-4 opacity-20" />
               <p>No leads found in this section.</p>
             </div>
           )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
            <div className="p-4 border-t border-gray-200 flex items-center justify-between bg-gray-50/50">
                <button 
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="p-2 rounded-lg hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                   <ChevronLeft size={18} />
                </button>
                <span className="text-xs font-bold text-gray-500">
                    Page {currentPage} of {totalPages}
                </span>
                <button 
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="p-2 rounded-lg hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                   <ChevronRight size={18} />
                </button>
            </div>
        )}
      </div>

      {/* BULK ACTION BAR (FLOATING) */}
      {selectedIds.length > 0 && (
        <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 bg-black text-white px-6 py-3 rounded-full shadow-2xl z-20 flex items-center gap-6 animate-in slide-in-from-bottom-5">
           <span className="text-sm font-bold flex items-center gap-2">
              <CheckCircle size={16} className="text-green-400" />
              {selectedIds.length} Selected
           </span>
           <div className="h-4 w-px bg-gray-700"></div>
           <div className="flex items-center gap-2">
              <button 
                onClick={() => setShowBulkCompose(true)}
                className="hover:text-blue-300 transition-colors text-sm font-medium flex items-center gap-2"
              >
                  <Send size={16} /> Broadcast
              </button>
              
              <button 
                 onClick={() => executeBulkStatusUpdate(LeadStatus.QUALIFIED)}
                 className="hover:text-green-300 transition-colors text-sm font-medium ml-4"
              >
                  Mark Qualified
              </button>
              
              <button 
                 onClick={() => setSelectedIds([])}
                 className="ml-4 p-1 hover:bg-gray-800 rounded-full"
              >
                  <X size={14} />
              </button>
           </div>
        </div>
      )}

      {/* BULK COMPOSE MODAL */}
      {showBulkCompose && (
          <div className="absolute inset-0 z-30 bg-black/20 backdrop-blur-sm flex items-end justify-end">
              <div className="w-96 bg-white h-full shadow-2xl border-l border-gray-200 flex flex-col animate-in slide-in-from-right duration-300">
                  <div className="p-4 border-b border-gray-100 flex items-center justify-between bg-gray-50">
                      <h3 className="font-bold text-gray-800 flex items-center gap-2">
                          <Send size={16} className="text-blue-600" /> 
                          Bulk Broadcast
                      </h3>
                      <button onClick={() => setShowBulkCompose(false)} className="text-gray-400 hover:text-gray-600">
                          <X size={20} />
                      </button>
                  </div>
                  
                  <div className="p-6 flex-1 flex flex-col">
                      <div className="bg-blue-50 p-3 rounded-lg border border-blue-100 mb-4 text-xs text-blue-800">
                          <p>Sending to <strong>{selectedIds.length}</strong> recipients in <strong>{activeSection}</strong>.</p>
                      </div>
                      
                      <label className="text-xs font-bold text-gray-500 uppercase mb-2">Message</label>
                      <textarea 
                          value={bulkMessage}
                          onChange={(e) => setBulkMessage(e.target.value)}
                          className="flex-1 w-full p-4 bg-gray-50 border border-gray-200 rounded-xl resize-none outline-none focus:ring-2 focus:ring-blue-500 mb-4 text-sm"
                          placeholder="Type your message here..."
                      />
                      
                      <button 
                          onClick={executeBulkSend}
                          disabled={!bulkMessage.trim()}
                          className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                      >
                          <Send size={18} /> Send Broadcast
                      </button>
                  </div>
              </div>
          </div>
      )}

    </div>
  );
};
