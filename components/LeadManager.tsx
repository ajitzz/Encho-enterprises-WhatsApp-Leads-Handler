import React, { useState, useMemo } from 'react';
import { Driver, LeadStatus } from '../types';
import {
  Search,
  Send,
  CheckCircle,
  AlertCircle,
  X,
  Users,
  ChevronLeft,
  ChevronRight,
  Phone,
  Zap,
  Paperclip,
  Clock
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
  drivers, onSelectDriver, onBulkSend
}) => {
  const [activeSection, setActiveSection] = useState<string>('All');
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showBulkCompose, setShowBulkCompose] = useState(false);

  const [bulkMessage, setBulkMessage] = useState('');
  const [selectedMedia, setSelectedMedia] = useState<{ url: string, type: 'image' | 'video' | 'document' } | null>(null);
  const [showMediaPicker, setShowMediaPicker] = useState(false);

  const [isScheduled, setIsScheduled] = useState(false);
  const [scheduleTime, setScheduleTime] = useState('');

  const sections = [
    { id: 'All', label: 'All Leads', icon: Users, color: 'text-gray-600' },
    { id: LeadStatus.NEW, label: 'New Inquiries', icon: Zap, color: 'text-blue-600' },
    { id: LeadStatus.QUALIFIED, label: 'Qualified', icon: CheckCircle, color: 'text-green-600' },
    { id: LeadStatus.FLAGGED_FOR_REVIEW, label: 'Flagged', icon: AlertCircle, color: 'text-amber-600' },
    { id: LeadStatus.REJECTED, label: 'Rejected', icon: X, color: 'text-red-600' }
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

  const activeSectionLabel = sections.find(section => section.id === activeSection)?.label || 'All Leads';

  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
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

  const executeBulkSend = async () => {
    if (!bulkMessage.trim() && !selectedMedia) return;

    let timestamp = Date.now();
    if (isScheduled) {
      if (!scheduleTime) {
        alert('Please select a date and time for the scheduled message.');
        return;
      }
      const selectedTime = new Date(scheduleTime).getTime();
      if (selectedTime <= Date.now()) {
        alert('Scheduled time must be in the future.');
        return;
      }
      timestamp = selectedTime;
    }

    try {
      await liveApiService.scheduleMessage(selectedIds, {
        text: bulkMessage,
        mediaUrl: selectedMedia?.url,
        mediaType: selectedMedia?.type
      }, timestamp);
      onBulkSend(selectedIds, bulkMessage, selectedMedia?.url, selectedMedia?.type, undefined, undefined, timestamp);
    } catch (e: any) {
      alert(`Failed: ${e.message}`);
      return;
    }

    setShowBulkCompose(false);
    setBulkMessage('');
    setSelectedMedia(null);
    setIsScheduled(false);
    setScheduleTime('');
    setSelectedIds([]);
  };

  return (
    <div className="relative flex h-[calc(100vh-100px)] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm lg:flex-row">
      <div className="border-b border-gray-200 bg-gray-50 lg:w-64 lg:shrink-0 lg:border-b-0 lg:border-r lg:flex lg:flex-col">
        <div className="border-b border-gray-200 px-4 py-3 lg:px-5 lg:py-4">
          <h2 className="text-sm font-bold text-gray-800 lg:text-base">Lead Sections</h2>
        </div>
        <nav className="scrollbar-thin flex gap-2 overflow-x-auto px-3 py-3 lg:block lg:space-y-1 lg:overflow-y-auto lg:px-3">
          {sections.map(section => (
            <button
              key={section.id}
              onClick={() => {
                setActiveSection(section.id);
                setCurrentPage(1);
                setSelectedIds([]);
              }}
              className={`flex min-w-max items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm font-medium transition-all lg:w-full ${activeSection === section.id
                ? 'border-gray-200 bg-white text-gray-900 shadow-sm'
                : 'border-transparent bg-gray-100 text-gray-500 hover:bg-gray-200 lg:bg-transparent lg:hover:bg-gray-100'
                }`}
            >
              <div className="flex items-center gap-2">
                <section.icon size={16} className={activeSection === section.id ? section.color : 'text-gray-400'} />
                <span className="whitespace-nowrap">{section.label}</span>
              </div>
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-bold">
                {section.id === 'All' ? drivers.length : drivers.filter(d => d.status === section.id).length}
              </span>
            </button>
          ))}
        </nav>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-gray-200 p-3 sm:p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-1 items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 sm:max-w-md">
              <Search size={18} className="text-gray-400" />
              <input
                type="text"
                placeholder="Search by name or phone"
                className="w-full border-none bg-transparent text-sm outline-none"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <div className="flex items-center justify-between text-xs sm:justify-end sm:gap-4">
              <span className="font-semibold text-gray-600">{activeSectionLabel}</span>
              <span className="rounded-full bg-gray-100 px-2.5 py-1 font-semibold text-gray-600">{filteredDrivers.length} leads</span>
            </div>
          </div>
        </div>

        <div className="hidden items-center border-b border-gray-200 bg-gray-50/50 px-6 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500 md:flex">
          <div className="w-10">
            <input
              type="checkbox"
              checked={selectedIds.length > 0 && selectedIds.length === filteredDrivers.length}
              onChange={handleSelectAll}
            />
          </div>
          <div className="flex-1">Driver Details</div>
          <div className="w-32">Status</div>
        </div>

        <div className="flex-1 overflow-y-auto pb-20 md:pb-0">
          {paginatedDrivers.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-gray-500">No leads found for this filter.</div>
          ) : (
            paginatedDrivers.map(driver => (
              <div
                key={driver.id}
                onClick={() => onSelectDriver(driver)}
                className={`cursor-pointer border-b border-gray-100 px-4 py-3 transition-colors hover:bg-blue-50/30 md:flex md:items-center md:px-6 md:py-4 ${selectedIds.includes(driver.id) ? 'bg-blue-50/50' : ''}`}
              >
                <div className="flex items-start gap-3 md:w-10 md:items-center" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(driver.id)}
                    onChange={() => handleSelectOne(driver.id)}
                    className="mt-1 md:mt-0"
                  />
                </div>
                <div className="mt-2 flex items-start justify-between gap-3 md:mt-0 md:flex-1 md:min-w-0 md:pr-4">
                  <div className="min-w-0">
                    <div className="truncate font-bold text-gray-900">{driver.name || 'Unnamed lead'}</div>
                    <div className="mt-1 flex items-center gap-1 text-xs text-gray-500">
                      <Phone size={10} />
                      <span className="truncate">{driver.phoneNumber}</span>
                    </div>
                  </div>
                  <div className="md:hidden">
                    <span className="rounded-full border bg-gray-100 px-2.5 py-1 text-[10px] font-bold uppercase text-gray-800">{driver.status}</span>
                  </div>
                </div>
                <div className="hidden w-32 md:block">
                  <span className="rounded-full border bg-gray-100 px-2.5 py-0.5 text-[10px] font-bold uppercase text-gray-800">{driver.status}</span>
                </div>
              </div>
            ))
          )}
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-gray-200 p-4">
            <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1}>
              <ChevronLeft size={18} />
            </button>
            <span className="text-xs font-bold text-gray-500">Page {currentPage} of {totalPages}</span>
            <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}>
              <ChevronRight size={18} />
            </button>
          </div>
        )}
      </div>

      {selectedIds.length > 0 && (
        <div className="fixed inset-x-3 bottom-4 z-20 rounded-2xl bg-black px-4 py-3 text-white shadow-2xl sm:left-1/2 sm:right-auto sm:w-auto sm:min-w-[360px] sm:-translate-x-1/2 sm:px-6">
          <div className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-2 text-sm font-bold">
              <CheckCircle size={16} className="text-green-400" />
              {selectedIds.length} Selected
            </span>
            <div className="flex items-center gap-3">
              <button onClick={() => setShowBulkCompose(true)} className="flex items-center gap-2 text-sm font-medium text-white/90 transition-colors hover:text-blue-300">
                <Send size={16} />
                Broadcast
              </button>
              <button onClick={() => setSelectedIds([])} className="rounded-full p-1 transition-colors hover:bg-gray-800">
                <X size={14} />
              </button>
            </div>
          </div>
        </div>
      )}

      {showBulkCompose && (
        <div className="absolute inset-0 z-30 flex items-end justify-end bg-black/20 backdrop-blur-sm">
          <div className="h-full w-full animate-in slide-in-from-right border-l border-gray-200 bg-white shadow-2xl duration-300 sm:w-[480px]">
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between border-b border-gray-100 bg-gray-50 p-4">
                <h3 className="flex items-center gap-2 font-bold text-gray-800"><Send size={16} className="text-blue-600" /> Bulk Broadcast</h3>
                <button onClick={() => setShowBulkCompose(false)}><X size={20} className="text-gray-400" /></button>
              </div>
              <div className="flex flex-1 flex-col space-y-4 overflow-y-auto p-4 sm:p-6">
                {selectedMedia && (
                  <div className="relative flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-100 p-2">
                    <Paperclip size={16} className="text-blue-600" />
                    <span className="flex-1 truncate font-mono text-xs">{selectedMedia.type.toUpperCase()} Selected</span>
                    <button onClick={() => setSelectedMedia(null)} className="hover:text-red-600"><X size={14} /></button>
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={() => setShowMediaPicker(true)}
                    className="flex items-center gap-1 rounded border border-gray-200 bg-gray-100 px-3 py-1.5 text-xs transition-colors hover:bg-gray-200"
                  >
                    <Paperclip size={12} /> Attach Media
                  </button>
                </div>

                <div className="rounded-lg border bg-gray-50 p-3">
                  <label className="mb-2 flex items-center gap-2 text-xs font-bold text-gray-600"><Clock size={14} /> Schedule Send</label>
                  <div className="mb-2 flex items-center gap-2">
                    <input type="checkbox" id="scheduleCheck" checked={isScheduled} onChange={(e) => setIsScheduled(e.target.checked)} className="cursor-pointer" />
                    <label htmlFor="scheduleCheck" className="cursor-pointer select-none text-sm">Send later</label>
                  </div>
                  {isScheduled && <input type="datetime-local" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} className="w-full rounded border bg-white p-2 text-sm" />}
                </div>

                <textarea
                  value={bulkMessage}
                  onChange={(e) => setBulkMessage(e.target.value)}
                  className="min-h-[120px] w-full resize-none rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Type message..."
                />
              </div>
              <div className="border-t border-gray-100 bg-gray-50 p-4 sm:p-6">
                <button
                  onClick={executeBulkSend}
                  disabled={(!bulkMessage.trim() && !selectedMedia)}
                  className="w-full rounded-xl bg-blue-600 py-3.5 font-bold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                >
                  {isScheduled ? 'Schedule Broadcast' : 'Send Broadcast Now'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <MediaSelectorModal
        isOpen={showMediaPicker}
        onClose={() => setShowMediaPicker(false)}
        onSelect={(url, type) => {
          setSelectedMedia({ url, type });
          setShowMediaPicker(false);
        }}
        allowedType="All"
      />
    </div>
  );
};
