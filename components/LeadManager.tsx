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
  Clock,
  Flame,
  ListFilter,
  Timer,
  CircleDot
} from 'lucide-react';
import { MediaSelectorModal } from './MediaSelectorModal.tsx';
import { liveApiService } from '../services/liveApiService';

interface LeadManagerProps {
  drivers: Driver[];
  onSelectDriver: (driver: Driver) => void;
  onBulkSend: (ids: string[], message: string, mediaUrl?: string, mediaType?: string, options?: string[], templateName?: string, scheduledTime?: number) => void;
  onUpdateDriverStatus: (ids: string[], status: LeadStatus) => void;
}

type PriorityBand = 'hot' | 'warm' | 'cold';
type QueueFilter = 'all' | 'hot' | 'warm' | 'cold' | 'overdue' | 'fresh';

interface LeadInsight {
  score: number;
  priority: PriorityBand;
  nextAction: string;
  followupAt: number | null;
  isOverdue: boolean;
}

const ITEMS_PER_PAGE = 15;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

const getVariableText = (driver: Driver, keys: string[]): string => {
  for (const key of keys) {
    const value = driver.variables?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
  }
  return '';
};

const getFollowupAt = (driver: Driver): number | null => {
  const candidates = ['next_followup_at', 'nextFollowupAt', 'followup_at', 'followupAt'];
  for (const key of candidates) {
    const raw = driver.variables?.[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw > 10_000_000_000 ? raw : raw * 1000;
    }
    if (typeof raw === 'string' && raw.trim()) {
      const parsed = Date.parse(raw);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
};

const buildLeadInsight = (driver: Driver): LeadInsight => {
  let score = 0;

  if (driver.status === LeadStatus.QUALIFIED) score += 35;
  if (driver.status === LeadStatus.NEW) score += 20;
  if (driver.status === LeadStatus.FLAGGED_FOR_REVIEW) score += 8;
  if (driver.status === LeadStatus.REJECTED) score -= 35;

  const source = (driver.source || '').toLowerCase();
  if (['meta_ads', 'facebook_ads', 'google_ads', 'paid'].some((tag) => source.includes(tag))) score += 20;
  if (source.includes('organic')) score += 10;

  const intentText = getVariableText(driver, ['intent', 'interest_level', 'urgency', 'timeline']);
  if (/ready|urgent|today|now|immediately|high/.test(intentText)) score += 25;
  if (/later|maybe|not sure|low/.test(intentText)) score -= 12;

  const docsText = getVariableText(driver, ['license_status', 'document_status', 'kyc_status']);
  if (/approved|complete|uploaded|valid/.test(docsText)) score += 18;
  if (/missing|invalid|rejected/.test(docsText)) score -= 15;

  const lastMessageAge = Date.now() - (driver.lastMessageTime || 0);
  if (lastMessageAge < FIFTEEN_MINUTES_MS) score += 12;
  else if (lastMessageAge > TWENTY_FOUR_HOURS_MS) score -= 8;

  score = Math.max(0, Math.min(100, score));

  const followupAt = getFollowupAt(driver);
  const isOverdue = Boolean(followupAt && followupAt < Date.now());

  const priority: PriorityBand = score >= 70 ? 'hot' : score >= 40 ? 'warm' : 'cold';
  const nextAction = isOverdue
    ? 'Follow-up now'
    : priority === 'hot'
      ? 'Call immediately'
      : priority === 'warm'
        ? 'Send qualification template'
        : 'Add to nurture flow';

  return { score, priority, nextAction, followupAt, isOverdue };
};

const priorityStyles: Record<PriorityBand, string> = {
  hot: 'bg-red-50 text-red-700 border-red-200',
  warm: 'bg-amber-50 text-amber-700 border-amber-200',
  cold: 'bg-slate-100 text-slate-700 border-slate-200'
};

const formatFollowupLabel = (value: number | null) => {
  if (!value) return 'No follow-up set';
  return new Date(value).toLocaleString();
};

export const LeadManager: React.FC<LeadManagerProps> = ({
  drivers, onSelectDriver, onBulkSend
}) => {
  const [activeSection, setActiveSection] = useState<string>('All');
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showBulkCompose, setShowBulkCompose] = useState(false);
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('all');

  const [bulkMessage, setBulkMessage] = useState('');
  const [selectedMedia, setSelectedMedia] = useState<{ url: string, type: 'image' | 'video' | 'document' | 'audio' } | null>(null);
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

  const enrichedDrivers = useMemo(() => drivers.map((driver) => ({
    ...driver,
    insight: buildLeadInsight(driver)
  })), [drivers]);

  const queueCounters = useMemo(() => ({
    all: enrichedDrivers.length,
    hot: enrichedDrivers.filter((d) => d.insight.priority === 'hot').length,
    warm: enrichedDrivers.filter((d) => d.insight.priority === 'warm').length,
    cold: enrichedDrivers.filter((d) => d.insight.priority === 'cold').length,
    overdue: enrichedDrivers.filter((d) => d.insight.isOverdue).length,
    fresh: enrichedDrivers.filter((d) => Date.now() - (d.lastMessageTime || 0) < FIFTEEN_MINUTES_MS).length
  }), [enrichedDrivers]);

  const queueOptions: Array<{ id: QueueFilter; label: string; icon: React.ReactNode }> = [
    { id: 'all', label: 'All', icon: <ListFilter size={14} /> },
    { id: 'hot', label: 'Hot', icon: <Flame size={14} /> },
    { id: 'warm', label: 'Warm', icon: <CircleDot size={14} /> },
    { id: 'cold', label: 'Cold', icon: <CircleDot size={14} /> },
    { id: 'overdue', label: 'Overdue', icon: <Timer size={14} /> },
    { id: 'fresh', label: 'Fresh 15m', icon: <Clock size={14} /> }
  ];

  const filteredDrivers = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();

    const queueFiltered = enrichedDrivers.filter((driver) => {
      if (queueFilter === 'all') return true;
      if (queueFilter === 'overdue') return driver.insight.isOverdue;
      if (queueFilter === 'fresh') return Date.now() - (driver.lastMessageTime || 0) < FIFTEEN_MINUTES_MS;
      return driver.insight.priority === queueFilter;
    });

    const sectionFiltered = queueFiltered.filter((driver) => activeSection === 'All' || driver.status === activeSection);

    const searchFiltered = sectionFiltered.filter((driver) => {
      if (!normalizedSearch) return true;
      return driver.name.toLowerCase().includes(normalizedSearch) || driver.phoneNumber.includes(normalizedSearch);
    });

    return searchFiltered.sort((a, b) => {
      if (b.insight.score !== a.insight.score) return b.insight.score - a.insight.score;
      return (b.lastMessageTime || 0) - (a.lastMessageTime || 0);
    });
  }, [enrichedDrivers, activeSection, searchTerm, queueFilter]);

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
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  setCurrentPage(1);
                }}
              />
            </div>
            <div className="flex items-center justify-between text-xs sm:justify-end sm:gap-4">
              <span className="font-semibold text-gray-600">{activeSectionLabel}</span>
              <span className="rounded-full bg-gray-100 px-2.5 py-1 font-semibold text-gray-600">{filteredDrivers.length} leads</span>
            </div>
          </div>

          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {queueOptions.map((option) => (
              <button
                key={option.id}
                onClick={() => {
                  setQueueFilter(option.id);
                  setCurrentPage(1);
                }}
                className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${queueFilter === option.id
                  ? 'border-blue-200 bg-blue-50 text-blue-700'
                  : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                  }`}
              >
                {option.icon}
                {option.label}
                <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-bold text-gray-700">{queueCounters[option.id]}</span>
              </button>
            ))}
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
          <div className="w-52">Priority & Follow-up</div>
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
                <div className="mt-2 flex min-w-0 flex-1 items-start justify-between gap-3 md:mt-0 md:pr-4">
                  <div className="min-w-0">
                    <div className="truncate font-bold text-gray-900">{driver.name || 'Unnamed lead'}</div>
                    <div className="mt-1 flex items-center gap-1 text-xs text-gray-500">
                      <Phone size={10} />
                      <span className="truncate">{driver.phoneNumber}</span>
                    </div>
                    <div className="mt-2 text-xs text-gray-500">
                      <span className="font-medium text-gray-700">Next:</span> {driver.insight.nextAction}
                    </div>
                  </div>
                  <div className="space-y-1 md:hidden">
                    <span className={`inline-block rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase ${priorityStyles[driver.insight.priority]}`}>{driver.insight.priority}</span>
                    <div className={`text-[10px] font-semibold ${driver.insight.isOverdue ? 'text-red-600' : 'text-gray-500'}`}>
                      {driver.insight.isOverdue ? 'Overdue' : formatFollowupLabel(driver.insight.followupAt)}
                    </div>
                    <span className="inline-block rounded-full border bg-gray-100 px-2.5 py-1 text-[10px] font-bold uppercase text-gray-800">{driver.status}</span>
                  </div>
                </div>
                <div className="hidden w-52 md:block">
                  <div className="space-y-1">
                    <span className={`inline-block rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase ${priorityStyles[driver.insight.priority]}`}>{driver.insight.priority} • {driver.insight.score}</span>
                    <div className={`text-xs font-medium ${driver.insight.isOverdue ? 'text-red-600' : 'text-gray-500'}`}>
                      {driver.insight.isOverdue ? 'Follow-up overdue' : formatFollowupLabel(driver.insight.followupAt)}
                    </div>
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
