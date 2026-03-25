
import React, { useState, useEffect } from 'react';
import { 
  LayoutDashboard, 
  Users, 
  MessageSquare, 
  Phone, 
  CheckCircle, 
  Clock, 
  ChevronRight, 
  Search, 
  Filter, 
  Plus, 
  ArrowLeft, 
  Send, 
  MoreVertical, 
  Loader2, 
  AlertCircle,
  History,
  UserCheck,
  Zap,
  Calendar,
  ClipboardList,
  LogOut,
  X,
  ShieldAlert,
  Paperclip,
  Mic,
  Video,
  FileText,
  User,
  Bot,
  Inbox,
  BarChart3,
  ShieldCheck,
  UserCog,
  ListFilter,
  TrendingUp,
  AlertTriangle
} from 'lucide-react';
import { liveApiService } from '../services/liveApiService.ts';
import { getLeadScreenshotUploadPath } from '../services/mediaPaths';
import { Driver, Message } from '../types.ts';
import { VoiceRecorder } from './VoiceRecorder.tsx';
import { ActionCenter } from './ActionCenter.tsx';
import { CommandCenter } from './CommandCenter.tsx';
import { PendingReviews } from './PendingReviews.tsx';
import { LeadReviewModal } from './LeadReviewModal.tsx';
import { ScheduledAlertPopup } from './ScheduledAlertPopup.tsx';
import { DueAlertItem } from '../services/liveApiService.ts';

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
      <div className="flex items-center gap-1.5 px-2 py-1 bg-red-50 text-red-600 rounded-lg text-[9px] font-bold uppercase tracking-wider border border-red-100">
        <ShieldAlert size={10} />
        Expired
      </div>
    );
  }

  const hours = Math.floor(timeLeft / (60 * 60 * 1000));
  const minutes = Math.floor((timeLeft % (60 * 60 * 1000)) / (60 * 1000));
  const seconds = Math.floor((timeLeft % (60 * 1000)) / 1000);

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 bg-emerald-50 text-emerald-600 rounded-lg text-[9px] font-bold uppercase tracking-wider border border-emerald-100">
      <Clock size={10} className="animate-pulse" />
      {hours}h {minutes}m {seconds}s
    </div>
  );
};

interface LeadActivity {
  id: string;
  action: string;
  notes: string;
  created_at: string;
  staff_name: string;
  next_followup_at?: string | null;
  metadata?: {
    previous_status?: string | null;
    new_status?: string | null;
    previous_followup_at?: string | null;
    new_followup_at?: string | null;
    status_changed?: boolean;
    followup_changed?: boolean;
    interaction_followup_at?: string | null;
  };
}

export const StaffPortal: React.FC<{ user: any; onLogout: () => void }> = ({ user, onLogout }) => {
  const [view, setView] = useState<'dashboard' | 'pool' | 'my-leads' | 'detail' | 'team' | 'action-center' | 'command-center' | 'pending-reviews' | 'manager-workspace'>('dashboard');
  const [managerTab, setManagerTab] = useState<'team-leads' | 'team-members' | 'assignments' | 'reports' | 'audit'>('team-leads');
  const [managerStatusFilter, setManagerStatusFilter] = useState<'all' | 'overdue' | 'unassigned' | 'booked'>('all');
  const [managerStaffFilter, setManagerStaffFilter] = useState<string>('all');
  const [assignmentStrategy, setAssignmentStrategy] = useState<'manual' | 'least-loaded' | 'round-robin'>('manual');
  const [roundRobinCursor, setRoundRobinCursor] = useState(0);
  const [reportRange, setReportRange] = useState<'7d' | '30d' | '90d'>('30d');
  const [managerAuditFeed, setManagerAuditFeed] = useState<LeadActivity[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditActionFilter, setAuditActionFilter] = useState<string>('all');
  const [auditStaffFilter, setAuditStaffFilter] = useState<string>('all');
  const [allLeads, setAllLeads] = useState<Driver[]>([]);
  const [teamStaff, setTeamStaff] = useState<any[]>([]);
  const [selectedLead, setSelectedLead] = useState<Driver | null>(null);
  const [activities, setActivities] = useState<LeadActivity[]>([]);
  const [leadMessages, setLeadMessages] = useState<Message[]>([]);
  const [detailTab, setDetailTab] = useState<'chat' | 'activity'>('chat');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [actionNote, setActionNote] = useState('');
  const [actionStatus, setActionStatus] = useState('');
  const [connectionState, setConnectionState] = useState<string>('connecting');
  const [replyText, setReplyText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [selectedMedia, setSelectedMedia] = useState<{ type: 'image' | 'video' | 'document' | 'audio'; file: File; preview: string } | null>(null);
  const [isHumanModeLoading, setIsHumanModeLoading] = useState(false);
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [reminders, setReminders] = useState<any[]>([]);
  const [nextFollowup, setNextFollowup] = useState('');
  const [assigningTo, setAssigningTo] = useState<string | null>(null);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [closingScreenshot, setClosingScreenshot] = useState<{ file: File; preview: string } | null>(null);
  const [dueAlertQueue, setDueAlertQueue] = useState<DueAlertItem[]>([]);
  const [activeDueAlert, setActiveDueAlert] = useState<DueAlertItem | null>(null);

  const formatDateTime = (value?: string | null) => {
    if (!value) return '—';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '—';
    return parsed.toLocaleString();
  };

  const formatTimelineTime = formatDateTime;

  const toLabel = (value?: string | null) => {
    if (!value) return '—';
    return value.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  };

  const getActivityDetails = (activity: LeadActivity) => {
    const scheduledForInteraction = activity.metadata?.interaction_followup_at ?? activity.metadata?.new_followup_at ?? activity.next_followup_at ?? null;

    return [
      {
        label: 'Status',
        value: toLabel(activity.metadata?.new_status) === '—' ? 'Not updated' : toLabel(activity.metadata?.new_status),
        tone: 'blue' as const
      },
      {
        label: 'Scheduled Date',
        value: formatDateTime(scheduledForInteraction) === '—'
          ? 'Not scheduled'
          : formatDateTime(scheduledForInteraction),
        tone: 'violet' as const
      }
    ];
  };

  const isWindowActive = selectedLead ? (Date.now() - selectedLead.lastMessageTime < 24 * 60 * 60 * 1000) : false;

  const handleToggleHumanMode = async () => {
    if (!selectedLead || isHumanModeLoading) return;
    
    const newMode = !selectedLead.isHumanMode;
    setIsHumanModeLoading(true);
    try {
      await liveApiService.updateDriver(selectedLead.id, { isHumanMode: newMode });
      
      // Predefined messages
      if (newMode) {
        // Entering Human Mode
        await liveApiService.sendMessage(selectedLead.id, `Hi, I am ${user.name}, how may I help you?`);
      } else {
        // Exiting Human Mode
        await liveApiService.sendMessage(selectedLead.id, `Chatbot resumed. I'm back online.`);
      }

      // Update local state
      const updatedLead = { ...selectedLead, isHumanMode: newMode };
      setSelectedLead(updatedLead);
      setAllLeads(prev => prev.map(l => l.id === updatedLead.id ? updatedLead : l));
      
      // Refresh messages
      const messages = await liveApiService.getDriverMessages(selectedLead.id);
      setLeadMessages(messages);
    } catch (err) {
      console.error('Failed to toggle human mode:', err);
      setError('Failed to toggle human mode');
    } finally {
      setIsHumanModeLoading(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    let type: 'image' | 'video' | 'document' | 'audio' = 'document';
    if (file.type.startsWith('image/')) type = 'image';
    else if (file.type.startsWith('video/')) type = 'video';
    else if (file.type.startsWith('audio/')) type = 'audio';
    
    const preview = URL.createObjectURL(file);
    setSelectedMedia({ type, file, preview });
  };

  const handleSendReply = async () => {
    if (!selectedLead || (!replyText.trim() && !selectedMedia) || isSending) return;
    
    setIsSending(true);
    try {
      let mediaUrl = undefined;
      let mediaType = undefined;

      if (selectedMedia) {
        const upload = await liveApiService.uploadMedia(selectedMedia.file, `chats/${selectedLead.id}`);
        mediaUrl = upload.url;
        mediaType = selectedMedia.type;
      }

      await liveApiService.sendMessage(selectedLead.id, replyText, {
        type: mediaType || 'text',
        imageUrl: mediaType === 'image' ? mediaUrl : undefined,
        videoUrl: mediaType === 'video' ? mediaUrl : undefined,
        documentUrl: mediaType === 'document' ? mediaUrl : undefined,
        audioUrl: mediaType === 'audio' ? mediaUrl : undefined
      });

      setReplyText('');
      setSelectedMedia(null);
      // Refresh messages
      const messages = await liveApiService.getDriverMessages(selectedLead.id);
      setLeadMessages(messages);
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setIsSending(false);
    }
  };

  const handleVoiceSend = async (blob: Blob) => {
    if (!selectedLead) return;
    setIsSending(true);
    try {
      const file = new File([blob], `voice_recording_${Date.now()}.ogg`, { type: 'audio/ogg' });
      const uploadResult = await liveApiService.uploadMedia(file, `voice_recordings/${selectedLead.id}`);
      if (uploadResult.success) {
        await liveApiService.sendMessage(selectedLead.id, '', { 
          mediaUrl: uploadResult.url, 
          mediaType: 'audio'
        });
        // Refresh messages
        const messages = await liveApiService.getDriverMessages(selectedLead.id);
        setLeadMessages(messages);
      }
    } catch (error) {
      console.error('Failed to send voice recording:', error);
    } finally {
      setIsSending(false);
      setIsRecordingVoice(false);
    }
  };

  const myLeads = React.useMemo(() => 
    allLeads.filter(l => (l as any).assigned_to === user.staffId),
    [allLeads, user.staffId]
  );

  const poolLeads = React.useMemo(() => 
    allLeads.filter(l => !(l as any).assigned_to),
    [allLeads]
  );

  const isManagerRole = user.role === 'manager' || user.role === 'admin';
  const teamMemberIds = React.useMemo(() => new Set(teamStaff.map((staff) => staff.id)), [teamStaff]);
  const reportStartDate = React.useMemo(() => {
    const days = reportRange === '7d' ? 7 : reportRange === '30d' ? 30 : 90;
    const start = new Date();
    start.setDate(start.getDate() - days);
    return start;
  }, [reportRange]);
  const teamLeads = React.useMemo(
    () => allLeads.filter((lead) => {
      const assignedTo = (lead as any).assigned_to;
      return assignedTo ? (teamMemberIds.has(assignedTo) || assignedTo === user.staffId) : true;
    }),
    [allLeads, teamMemberIds, user.staffId]
  );
  const scopedReportLeads = React.useMemo(
    () =>
      teamLeads.filter((lead) => {
        const createdAt = new Date((lead as any).created_at || Date.now());
        return !Number.isNaN(createdAt.getTime()) && createdAt >= reportStartDate;
      }),
    [teamLeads, reportStartDate]
  );
  const filteredManagerLeads = React.useMemo(() => {
    return teamLeads.filter((lead) => {
      const assignedTo = (lead as any).assigned_to || 'unassigned';
      if (managerStaffFilter !== 'all' && assignedTo !== managerStaffFilter) return false;
      if (managerStatusFilter === 'overdue') {
        const nextFollowup = (lead as any).next_followup_at;
        return !!nextFollowup && new Date(nextFollowup).getTime() < Date.now();
      }
      if (managerStatusFilter === 'unassigned') return !assignedTo || assignedTo === 'unassigned';
      if (managerStatusFilter === 'booked') return (lead as any).lead_status === 'booked';
      return true;
    });
  }, [teamLeads, managerStaffFilter, managerStatusFilter]);
  const filteredAuditFeed = React.useMemo(() => {
    return managerAuditFeed.filter((entry) => {
      if (auditActionFilter !== 'all' && entry.action !== auditActionFilter) return false;
      if (auditStaffFilter !== 'all' && entry.staff_name !== auditStaffFilter) return false;
      return true;
    });
  }, [managerAuditFeed, auditActionFilter, auditStaffFilter]);

  const filteredLeads = React.useMemo(() => {
    const activeLeads = view === 'pool' ? poolLeads : (view === 'my-leads' || view === 'dashboard' ? myLeads : []);
    if (!searchQuery) return activeLeads;
    const query = searchQuery.toLowerCase();
    return activeLeads.filter(l => 
      (l.name || '').toLowerCase().includes(query) || 
      ((l as any).phone_number || '').includes(query)
    );
  }, [view, poolLeads, myLeads, searchQuery]);

  useEffect(() => {
    const unsubscribe = liveApiService.subscribeToUpdates(
      (drivers) => {
        setAllLeads(drivers);
        setLoading(false);
      },
      {
        driverId: selectedLead?.id,
        onMessages: (msgs) => setLeadMessages(msgs),
        onConnectionStateChange: (state) => setConnectionState(state)
      }
    );
    return () => unsubscribe();
  }, [selectedLead?.id]);

  useEffect(() => {
    if (user.role === 'manager' || user.role === 'admin') {
      liveApiService.getStaff().then(staff => {
        if (user.role === 'manager') {
          setTeamStaff(staff.filter(s => s.manager_id === user.staffId));
        } else {
          setTeamStaff(staff);
        }
      }).catch(err => console.error('Failed to fetch team', err));
    }
  }, [user.role, user.staffId]);

  const handleClaim = async (id: string) => {
    try {
      setLoading(true);
      await liveApiService.claimLead(id);
      setView('my-leads');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenDetail = async (lead: Driver) => {
    setSelectedLead(lead);
    setView('detail');
    setDetailTab('chat');
    try {
      const [history, messages] = await Promise.all([
        liveApiService.getLeadActivity(lead.id),
        liveApiService.getDriverMessages(lead.id, 50)
      ]);
      setActivities(history);
      setLeadMessages(messages);
    } catch (err) {
      console.error('Failed to fetch activity', err);
    }
  };

  useEffect(() => {
    liveApiService.getReminders().then(setReminders).catch(err => console.error('Failed to fetch reminders', err));
  }, []);

  useEffect(() => {
    const seenKey = `due_alerts_seen:${user.staffId || user.email || 'staff'}`;
    const readSeenIds = () =>
      new Set<string>(JSON.parse(localStorage.getItem(seenKey) || '[]'));

    const syncDueAlerts = async () => {
      try {
        const alerts = await liveApiService.getDueAlerts();
        const seenIds = readSeenIds();
        const fresh = alerts.filter(alert => !seenIds.has(alert.event_id));
        if (fresh.length > 0) {
          setDueAlertQueue(prev => {
            const existing = new Set(prev.map(item => item.event_id));
            if (activeDueAlert?.event_id) {
              existing.add(activeDueAlert.event_id);
            }
            return [...prev, ...fresh.filter(item => !existing.has(item.event_id))];
          });
        }
      } catch (err) {
        console.error('Failed to fetch due alerts', err);
      }
    };

    syncDueAlerts();
    const timer = setInterval(syncDueAlerts, 30000);
    return () => clearInterval(timer);
  }, [user.staffId, user.email, activeDueAlert?.event_id]);

  useEffect(() => {
    if (activeDueAlert || dueAlertQueue.length === 0) return;
    const next = dueAlertQueue[0];
    const seenKey = `due_alerts_seen:${user.staffId || user.email || 'staff'}`;
    const seenIds = new Set<string>(JSON.parse(localStorage.getItem(seenKey) || '[]'));
    if (seenIds.has(next.event_id)) {
      setDueAlertQueue(prev => prev.slice(1));
      return;
    }
    setActiveDueAlert(next);
    setDueAlertQueue(prev => prev.slice(1));
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(`Lead Alert: ${next.lead_name}`, {
        body: `Scheduled time reached at ${new Date(next.scheduled_at).toLocaleString()}`
      });
    }
  }, [dueAlertQueue, activeDueAlert, user.staffId, user.email]);

  const dismissDueAlert = (eventId?: string) => {
    if (!eventId) {
      setActiveDueAlert(null);
      return;
    }
    const seenKey = `due_alerts_seen:${user.staffId || user.email || 'staff'}`;
    const seenIds = new Set<string>(JSON.parse(localStorage.getItem(seenKey) || '[]'));
    seenIds.add(eventId);
    localStorage.setItem(seenKey, JSON.stringify(Array.from(seenIds)));
    setActiveDueAlert(null);
  };

  const handleMarkReminderDone = async (id: string) => {
    try {
      await liveApiService.markReminderDone(id);
      setReminders(prev => prev.filter(r => r.id !== id));
    } catch (err) {
      console.error('Failed to mark reminder done', err);
    }
  };

  const handleAssignLead = async (leadId: string, staffId: string) => {
    try {
      setLoading(true);
      await liveApiService.assignLead(leadId, staffId);
      setAssigningTo(null);
      // Refresh leads
      const drivers = await liveApiService.getDrivers();
      setAllLeads(drivers);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const getStrategyStaffId = () => {
    if (teamStaff.length === 0) return null;
    if (assignmentStrategy === 'manual') return teamStaff[0]?.id || null;
    if (assignmentStrategy === 'least-loaded') {
      const leadLoadByStaff = teamStaff.map((staff) => ({
        staffId: staff.id,
        load: allLeads.filter((lead) => (lead as any).assigned_to === staff.id).length
      }));
      leadLoadByStaff.sort((a, b) => a.load - b.load);
      return leadLoadByStaff[0]?.staffId || null;
    }
    const nextStaff = teamStaff[roundRobinCursor % teamStaff.length];
    setRoundRobinCursor((prev) => prev + 1);
    return nextStaff?.id || null;
  };

  const handleStrategyAssign = async (leadId: string) => {
    const staffId = getStrategyStaffId();
    if (!staffId) return;
    await handleAssignLead(leadId, staffId);
  };

  const handleReassignLead = async (leadId: string, staffId: string) => {
    try {
      setLoading(true);
      await liveApiService.reassignLead(leadId, staffId);
      setAssigningTo(null);
      // Refresh leads
      const drivers = await liveApiService.getDrivers();
      setAllLeads(drivers);
      if (selectedLead?.id === leadId) {
        const updated = drivers.find(d => d.id === leadId);
        if (updated) setSelectedLead(updated);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const loadManagerAudit = async () => {
      if (!isManagerRole || managerTab !== 'audit') return;
      setAuditLoading(true);
      try {
        const scopedLeadIds = teamLeads.slice(0, 12).map((lead) => lead.id);
        const batches = await Promise.all(
          scopedLeadIds.map((leadId) => liveApiService.getLeadActivity(leadId).catch(() => []))
        );
        const combined = batches.flat().slice(0, 200) as LeadActivity[];
        combined.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        setManagerAuditFeed(combined);
      } catch (err) {
        console.error('Failed to fetch manager audit feed', err);
      } finally {
        setAuditLoading(false);
      }
    };

    loadManagerAudit();
  }, [isManagerRole, managerTab, teamLeads]);

  const handleLogAction = async (action: string) => {
    if (!selectedLead) return;
    if (action === 'interaction') {
      if (!actionStatus) {
        setError('Please select a status before saving the interaction.');
        return;
      }
      if (!actionNote.trim()) {
        setError('Please add an interaction note before saving.');
        return;
      }
    }
    try {
      setLoading(true);
      
      let media_url = undefined;
      if (action === 'submitted_for_closing' && closingScreenshot) {
        const upload = await liveApiService.uploadMedia(
          closingScreenshot.file,
          getLeadScreenshotUploadPath(selectedLead)
        );
        media_url = upload.url;
      }

      await liveApiService.logLeadAction(selectedLead.id, {
        action,
        notes: actionNote.trim(),
        status: actionStatus || (action === 'submitted_for_closing' ? 'booked' : undefined),
        media_url,
        next_followup_at: nextFollowup || undefined
      });
      
      setActionNote('');
      setActionStatus('');
      setNextFollowup('');
      setClosingScreenshot(null);
      
      // Refresh activity
      const history = await liveApiService.getLeadActivity(selectedLead.id);
      setActivities(history);
      // Lead data will be updated via the stream
      const updated = allLeads.find(l => l.id === selectedLead.id);
      if (updated) setSelectedLead(updated);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const renderDashboard = () => (
    <div className="p-4 space-y-6 animate-in fade-in duration-300">
      <div className="bg-black text-white p-6 rounded-3xl shadow-xl relative overflow-hidden">
        <div className="absolute top-4 right-4 flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${
            connectionState === 'connected' ? 'bg-green-500 animate-pulse' : 
            connectionState === 'connecting' || connectionState === 'reconnecting' ? 'bg-yellow-500' : 'bg-red-500'
          }`} />
          <span className="text-[10px] font-bold uppercase tracking-widest opacity-50">
            {connectionState === 'connected' ? 'Live' : connectionState}
          </span>
        </div>
        <div className="relative z-10">
          <p className="text-gray-400 text-xs font-bold uppercase tracking-widest mb-1">Welcome back,</p>
          <h2 className="text-2xl font-bold">{user.name.split(' ')[0]}</h2>
          <div className="mt-6 grid grid-cols-2 gap-4">
            <div className="bg-white/10 backdrop-blur-md p-4 rounded-2xl border border-white/10">
              <p className="text-[10px] font-bold text-gray-400 uppercase">My Leads</p>
              <p className="text-2xl font-bold mt-1">{myLeads.length}</p>
            </div>
            <div className="bg-white/10 backdrop-blur-md p-4 rounded-2xl border border-white/10">
              <p className="text-[10px] font-bold text-gray-400 uppercase">Follow-ups</p>
              <p className="text-2xl font-bold mt-1">{myLeads.filter(l => (l as any).lead_status === 'followed_up').length}</p>
            </div>
          </div>
        </div>
        <div className="absolute -right-10 -bottom-10 w-40 h-40 bg-blue-600/20 rounded-full blur-3xl" />
      </div>

      {reminders.length > 0 && (
        <div className="bg-amber-50 border border-amber-100 rounded-3xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-amber-900 flex items-center gap-2">
              <Clock size={16} />
              Upcoming Reminders
            </h3>
            <span className="bg-amber-200 text-amber-800 text-[10px] font-bold px-2 py-0.5 rounded-full">
              {reminders.length}
            </span>
          </div>
          <div className="space-y-2">
            {reminders.map(reminder => (
              <div key={reminder.id} className="bg-white/60 p-3 rounded-2xl flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-gray-900 truncate">{reminder.lead_name}</p>
                  <p className="text-[10px] text-gray-500 truncate">{reminder.title || 'Follow-up'}</p>
                  <p className="text-[9px] text-amber-600 font-bold mt-0.5">
                    {new Date(reminder.scheduled_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
                <button 
                  onClick={() => handleMarkReminderDone(reminder.id)}
                  className="p-2 bg-white text-emerald-600 rounded-xl border border-emerald-100 hover:bg-emerald-50 transition-colors"
                >
                  <CheckCircle size={16} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4">
        <button 
          onClick={() => setView('action-center')}
          className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm flex items-center justify-between group active:scale-95 transition-all"
        >
          <div className="flex items-center gap-4">
            <div className="bg-emerald-100 text-emerald-600 p-3 rounded-2xl">
              <Inbox size={24} />
            </div>
            <div className="text-left">
              <h3 className="font-bold text-gray-900">Action Center</h3>
              <p className="text-xs text-gray-500">Your unified productivity inbox</p>
            </div>
          </div>
          <ChevronRight className="text-gray-300 group-hover:text-gray-900 transition-colors" />
        </button>

        {(user.role === 'manager' || user.role === 'admin') && (
          <button 
            onClick={() => setView('manager-workspace')}
            className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white p-5 rounded-3xl border border-blue-500 shadow-sm flex items-center justify-between group active:scale-95 transition-all"
          >
            <div className="flex items-center gap-4">
              <div className="bg-white/20 text-white p-3 rounded-2xl">
                <UserCog size={24} />
              </div>
              <div className="text-left">
                <h3 className="font-bold">Supervised Workspace</h3>
                <p className="text-xs text-blue-100">Team leads, assignments, reports & audit</p>
              </div>
            </div>
            <ChevronRight className="text-blue-100 group-hover:text-white transition-colors" />
          </button>
        )}

        {(user.role === 'manager' || user.role === 'admin') && (
          <div className="grid grid-cols-2 gap-3">
            <button 
              onClick={() => setView('command-center')}
              className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm flex flex-col items-center justify-center gap-2 group active:scale-95 transition-all"
            >
              <div className="bg-blue-100 text-blue-600 p-3 rounded-2xl">
                <BarChart3 size={24} />
              </div>
              <h3 className="font-bold text-gray-900 text-xs">Command Center</h3>
            </button>
            <button 
              onClick={() => setView('pending-reviews')}
              className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm flex flex-col items-center justify-center gap-2 group active:scale-95 transition-all"
            >
              <div className="bg-purple-100 text-purple-600 p-3 rounded-2xl">
                <ShieldCheck size={24} />
              </div>
              <h3 className="font-bold text-gray-900 text-xs">Pending Reviews</h3>
            </button>
          </div>
        )}

        <button 
          onClick={() => setView('pool')}
          className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm flex items-center justify-between group active:scale-95 transition-all"
        >
          <div className="flex items-center gap-4">
            <div className="bg-orange-100 text-orange-600 p-3 rounded-2xl">
              <Zap size={24} />
            </div>
            <div className="text-left">
              <h3 className="font-bold text-gray-900">Claim New Leads</h3>
              <p className="text-xs text-gray-500">Fresh leads waiting in the pool</p>
            </div>
          </div>
          <ChevronRight className="text-gray-300 group-hover:text-gray-900 transition-colors" />
        </button>

        <button 
          onClick={() => setView('my-leads')}
          className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm flex items-center justify-between group active:scale-95 transition-all"
        >
          <div className="flex items-center gap-4">
            <div className="bg-blue-100 text-blue-600 p-3 rounded-2xl">
              <ClipboardList size={24} />
            </div>
            <div className="text-left">
              <h3 className="font-bold text-gray-900">Manage My Leads</h3>
              <p className="text-xs text-gray-500">Follow up and close your deals</p>
            </div>
          </div>
          <ChevronRight className="text-gray-300 group-hover:text-gray-900 transition-colors" />
        </button>
      </div>

      <div className="pt-4">
        <h3 className="text-sm font-bold text-gray-900 mb-4 px-1">Recent Leads</h3>
        <div className="space-y-3">
          {myLeads.slice(0, 3).map(lead => (
            <div key={lead.id} onClick={() => handleOpenDetail(lead)} className="bg-white p-4 rounded-2xl border border-gray-100 flex items-center gap-3 cursor-pointer hover:bg-gray-50 transition-colors">
              <div className="w-10 h-10 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center font-bold">
                {lead.name.charAt(0)}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-bold text-gray-900">{lead.name}</p>
                  {((lead as any).lead_score || 0) > 0 && (
                    <div className="flex items-center gap-1 bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-lg text-[9px] font-bold">
                      <Zap size={8} fill="currentColor" />
                      {(lead as any).lead_score}
                    </div>
                  )}
                </div>
                <p className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">{(lead as any).lead_status || 'New'}</p>
              </div>
              <div className="text-right">
                <p className="text-[10px] text-gray-400">{new Date((lead as any).created_at).toLocaleDateString()}</p>
              </div>
            </div>
          ))}
          {myLeads.length === 0 && (
            <div className="text-center py-8 bg-gray-50 rounded-2xl border border-dashed border-gray-200">
              <p className="text-xs text-gray-400">You have no assigned leads yet. Claim some from the pool!</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const renderLeadList = (isPool: boolean) => (
    <div className="flex flex-col h-full animate-in slide-in-from-right duration-300">
      <div className="p-4 bg-white border-b border-gray-100 sticky top-0 z-10">
        <div className="flex items-center gap-3 mb-4">
          <button onClick={() => setView('dashboard')} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
            <ArrowLeft size={20} />
          </button>
          <h2 className="text-lg font-bold">{isPool ? 'Lead Pool' : 'My Leads'}</h2>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
          <input 
            type="text" 
            placeholder="Search leads..."
            className="w-full pl-10 pr-4 py-3 bg-gray-100 rounded-2xl text-sm border-none focus:ring-2 focus:ring-blue-500 transition-all"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="animate-spin text-blue-600 mb-2" size={32} />
            <p className="text-sm text-gray-500">Fetching leads...</p>
          </div>
        ) : filteredLeads.length === 0 ? (
          <div className="text-center py-20">
            <div className="bg-gray-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <Users size={32} className="text-gray-300" />
            </div>
            <p className="text-gray-500 font-medium">{isPool ? 'Pool is empty' : 'You have no assigned leads'}</p>
          </div>
        ) : (
          filteredLeads.map(lead => (
            <div 
              key={lead.id} 
              onClick={() => isPool ? null : handleOpenDetail(lead)}
              className="bg-white p-4 rounded-3xl border border-gray-100 shadow-sm active:scale-[0.98] transition-all"
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold text-lg">
                    {lead.name.charAt(0)}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="font-bold text-gray-900">{lead.name}</h4>
                      {((lead as any).lead_score || 0) > 0 && (
                        <div className="flex items-center gap-1 bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-lg text-[10px] font-bold">
                          <Zap size={10} fill="currentColor" />
                          {(lead as any).lead_score}
                        </div>
                      )}
                    </div>
                    <p className="text-xs text-gray-500">{(lead as any).phone_number}</p>
                  </div>
                </div>
                <div className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                  (lead as any).lead_status === 'new' ? 'bg-green-100 text-green-700' : 
                  (lead as any).lead_status === 'claimed' ? 'bg-blue-100 text-blue-700' :
                  'bg-gray-100 text-gray-700'
                }`}>
                  {(lead as any).lead_status || 'New'}
                </div>
              </div>
              
              <div className="flex items-center gap-2 mt-4">
                {isPool ? (
                  <div className="flex flex-col w-full gap-2">
                    <button 
                      onClick={(e) => { e.stopPropagation(); handleClaim(lead.id); }}
                      className="flex-1 bg-black text-white py-3 rounded-2xl text-xs font-bold flex items-center justify-center gap-2"
                    >
                      <UserCheck size={14} /> Claim Lead
                    </button>
                    {(user.role === 'manager' || user.role === 'admin') && (
                      <div className="flex flex-col gap-1">
                        <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest px-1">Assign to Team</p>
                        <div className="flex flex-wrap gap-1">
                          {teamStaff.filter(s => s.id !== user.staffId).map(staff => (
                            <button
                              key={staff.id}
                              onClick={(e) => { e.stopPropagation(); handleAssignLead(lead.id, staff.id); }}
                              className="bg-gray-100 hover:bg-blue-100 hover:text-blue-700 text-gray-600 px-3 py-1.5 rounded-xl text-[10px] font-bold transition-all"
                            >
                              {staff.name.split(' ')[0]}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <a 
                      href={`tel:${(lead as any).phone_number}`}
                      onClick={(e) => e.stopPropagation()}
                      className="flex-1 bg-blue-600 text-white py-3 rounded-2xl text-xs font-bold flex items-center justify-center gap-2"
                    >
                      <Phone size={14} /> Call
                    </a>
                    <a 
                      href={`https://wa.me/${((lead as any).phone_number || '').replace(/\D/g, '')}`}
                      onClick={(e) => e.stopPropagation()}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 bg-emerald-600 text-white py-3 rounded-2xl text-xs font-bold flex items-center justify-center gap-2"
                    >
                      <MessageSquare size={14} /> WhatsApp
                    </a>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );

  const renderDetail = () => {
    if (!selectedLead) return null;
    const lead = selectedLead as any;
    return (
      <div className="flex flex-col h-full bg-gray-50 animate-in slide-in-from-bottom duration-300">
        <div className="p-4 bg-white border-b border-gray-100 sticky top-0 z-10 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => setView('my-leads')} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
              <ArrowLeft size={20} />
            </button>
            <h2 className="text-lg font-bold">Lead Details</h2>
          </div>
          <div className="flex items-center gap-2">
            <button 
              onClick={handleToggleHumanMode}
              disabled={isHumanModeLoading}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-2xl text-[10px] font-bold uppercase tracking-wider transition-all ${
                selectedLead.isHumanMode 
                  ? 'bg-amber-100 text-amber-700 border border-amber-200' 
                  : 'bg-blue-50 text-blue-600 border border-blue-100'
              }`}
            >
              {isHumanModeLoading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : selectedLead.isHumanMode ? (
                <User size={12} />
              ) : (
                <Bot size={12} />
              )}
              {selectedLead.isHumanMode ? 'Human Mode ON' : 'Bot Active'}
            </button>
            <button className="p-2 hover:bg-gray-100 rounded-full">
              <MoreVertical size={20} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Lead Info Card */}
          <div className="p-6 bg-white border-b border-gray-100">
            <div className="flex flex-col items-center text-center">
              <div className="w-20 h-20 rounded-3xl bg-blue-600 text-white flex items-center justify-center font-bold text-3xl mb-4 shadow-lg shadow-blue-200">
                {lead.name.charAt(0)}
              </div>
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-xl font-bold text-gray-900">{lead.name}</h3>
                {((lead as any).lead_score || 0) > 0 && (
                  <div className="flex items-center gap-1 bg-amber-100 text-amber-700 px-2 py-0.5 rounded-lg text-[10px] font-bold">
                    <Zap size={12} fill="currentColor" />
                    {(lead as any).lead_score} Score
                  </div>
                )}
                <MetaWindowTimer lastMessageTime={lead.lastMessageTime} />
              </div>
              <p className="text-gray-500 mb-6">{lead.phone_number}</p>

              {/* Bot Progression */}
              <div className="w-full px-4 mb-6">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Bot Flow Progress</span>
                  <span className="text-[10px] font-bold text-blue-600 uppercase tracking-widest">{lead.progress_percent || 0}%</span>
                </div>
                <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-blue-600 transition-all duration-500 ease-out"
                    style={{ width: `${lead.progress_percent || 0}%` }}
                  />
                </div>
                <div className="flex justify-between mt-1">
                  <p className="text-[9px] text-gray-400 font-medium italic">
                    {lead.var_count || 0} variables collected
                  </p>
                  <p className="text-[9px] text-gray-400 font-medium italic">
                    {lead.user_msg_count || 0} messages sent
                  </p>
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-3 w-full">
                <a href={`tel:${lead.phone_number}`} className="flex flex-col items-center justify-center gap-2 p-4 bg-blue-50 text-blue-700 rounded-3xl border border-blue-100 active:scale-95 transition-all">
                  <Phone size={24} />
                  <span className="text-[10px] font-bold uppercase tracking-widest">Call Now</span>
                </a>
                <a href={`https://wa.me/${(lead.phone_number || '').replace(/\D/g, '')}`} target="_blank" rel="noopener noreferrer" className="flex flex-col items-center justify-center gap-2 p-4 bg-emerald-50 text-emerald-700 rounded-3xl border border-emerald-100 active:scale-95 transition-all">
                  <MessageSquare size={24} />
                  <span className="text-[10px] font-bold uppercase tracking-widest">WhatsApp</span>
                </a>
              </div>

              {(user.role === 'manager' || user.role === 'admin') && (
                <div className="w-full mt-4 p-4 bg-gray-100 rounded-3xl">
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2 px-1">Reassign Lead</p>
                  <div className="flex flex-wrap gap-2">
                    {teamStaff.filter(s => s.id !== lead.assigned_to).map(staff => (
                      <button
                        key={staff.id}
                        onClick={() => handleReassignLead(lead.id, staff.id)}
                        className="bg-white hover:bg-blue-600 hover:text-white text-gray-700 px-4 py-2 rounded-2xl text-xs font-bold transition-all shadow-sm"
                      >
                        {staff.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Tabs */}
          <div className="px-4 mt-6">
            <div className="flex bg-gray-100 p-1 rounded-2xl">
              <button 
                onClick={() => setDetailTab('chat')}
                className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 ${
                  detailTab === 'chat' ? 'bg-white text-black shadow-sm' : 'text-gray-500'
                }`}
              >
                <MessageSquare size={16} />
                Chat History
              </button>
              <button 
                onClick={() => setDetailTab('activity')}
                className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 ${
                  detailTab === 'activity' ? 'bg-white text-black shadow-sm' : 'text-gray-500'
                }`}
              >
                <ClipboardList size={16} />
                Activity & Notes
              </button>
            </div>
          </div>

          {detailTab === 'chat' ? (
            <div className="p-4 space-y-4 flex flex-col h-full">
              <div className="bg-white p-4 rounded-3xl border border-gray-100 shadow-sm flex-1 flex flex-col min-h-[400px]">
                  <div className="flex-1 space-y-4 overflow-y-auto max-h-[400px] pr-2 custom-scrollbar mb-4 p-2">
                    {leadMessages.map((msg, idx) => (
                      <div key={msg.id || idx} className={`flex ${msg.sender === 'driver' ? 'justify-start' : 'justify-end'}`}>
                        <div className={`max-w-[85%] p-3 rounded-2xl text-sm relative shadow-sm ${
                          msg.senderType === 'driver' 
                            ? 'bg-white text-gray-800 rounded-tl-none border border-gray-100' 
                            : msg.senderType === 'bot'
                            ? 'bg-black text-white rounded-tr-none'
                            : 'bg-emerald-500 text-white rounded-tr-none'
                        }`}>
                          {/* Message Content */}
                          <div className="space-y-2">
                            {msg.text && (
                              <p className="leading-relaxed whitespace-pre-wrap">
                                {msg.text.startsWith('{"url":') ? (() => {
                                  try { return JSON.parse(msg.text).caption || ''; } catch(e) { return ''; }
                                })() : msg.text}
                              </p>
                            )}
                            
                            {(msg.type === 'image' || msg.type === 'sticker') && msg.imageUrl && (
                              <div className="rounded-lg overflow-hidden border border-black/5">
                                <img src={msg.imageUrl} alt="Shared" className="max-w-full h-auto block" referrerPolicy="no-referrer" />
                              </div>
                            )}
                            
                            {msg.type === 'video' && msg.videoUrl && (
                              <div className="rounded-lg overflow-hidden border border-black/5 bg-black/10">
                                <video src={msg.videoUrl} controls className="max-w-full h-auto block" />
                              </div>
                            )}
                            
                            {(msg.type === 'audio' || msg.type === 'voice') && msg.audioUrl && (
                              <div className={`flex items-center gap-3 p-2 rounded-xl ${msg.senderType === 'driver' ? 'bg-gray-200' : msg.senderType === 'bot' ? 'bg-gray-800' : 'bg-emerald-600'}`}>
                                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${msg.senderType === 'driver' ? 'bg-gray-300 text-gray-600' : msg.senderType === 'bot' ? 'bg-gray-900 text-white' : 'bg-emerald-700 text-white'}`}>
                                  <Mic size={16} />
                                </div>
                                <audio src={msg.audioUrl} controls className="h-8 w-40" />
                              </div>
                            )}
                            
                            {msg.type === 'document' && msg.documentUrl && (
                              <a href={msg.documentUrl} target="_blank" rel="noopener noreferrer" className={`flex items-center gap-3 p-3 rounded-xl transition-colors ${
                                msg.senderType === 'driver' ? 'bg-gray-200 hover:bg-gray-300' : msg.senderType === 'bot' ? 'bg-gray-800 hover:bg-gray-900' : 'bg-emerald-600 hover:bg-emerald-700'
                              }`}>
                                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${msg.senderType === 'driver' ? 'bg-gray-300 text-gray-600' : msg.senderType === 'bot' ? 'bg-gray-900 text-white' : 'bg-emerald-700 text-white'}`}>
                                  <FileText size={20} />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className={`text-xs font-bold truncate ${msg.senderType === 'driver' ? 'text-gray-900' : 'text-white'}`}>Document</p>
                                  <p className={`text-[10px] ${msg.senderType === 'driver' ? 'text-gray-500' : 'text-white/60'}`}>Click to view</p>
                                </div>
                              </a>
                            )}
                          </div>

                          {/* Timestamp & Status */}
                          <div className={`flex items-center justify-end gap-1 mt-1 ${msg.senderType === 'driver' ? 'text-gray-400' : msg.senderType === 'bot' ? 'text-gray-400' : 'text-emerald-100'}`}>
                            <span className="text-[9px] font-medium">
                              {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                            {msg.senderType !== 'driver' && (
                              <div className="flex">
                                <CheckCircle size={10} className={msg.status === 'read' ? (msg.senderType === 'bot' ? 'text-blue-400' : 'text-blue-300') : ''} />
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  {leadMessages.length === 0 && (
                    <div className="flex-1 flex flex-col items-center justify-center text-center p-10">
                      <div className="w-16 h-16 rounded-full bg-gray-50 flex items-center justify-center mb-4">
                        <MessageSquare size={32} className="text-gray-200" />
                      </div>
                      <p className="text-sm font-bold text-gray-900">No messages yet</p>
                      <p className="text-xs text-gray-400 mt-1">The conversation hasn't started or history is unavailable.</p>
                    </div>
                  )}
                </div>

                {/* Chat Input Area */}
                <div className="pt-4 border-t border-gray-100">
                  {!isWindowActive ? (
                    <div className="flex flex-col items-center justify-center py-4 px-4 bg-gray-50 rounded-2xl border border-dashed border-gray-200">
                      <History size={20} className="text-gray-400 mb-2" />
                      <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">History Mode Only</p>
                      <p className="text-[9px] text-gray-400 text-center mt-1">Window expired. Waiting for customer response.</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {selectedMedia && (
                        <div className="flex items-center justify-between p-2 bg-blue-50 rounded-xl border border-blue-100 animate-in slide-in-from-bottom-2">
                          <div className="flex items-center gap-2">
                            {selectedMedia.type === 'image' ? (
                              <img src={selectedMedia.preview} className="w-10 h-10 rounded-lg object-cover border border-blue-200" alt="Preview" />
                            ) : (
                              <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center text-blue-600 border border-blue-200">
                                {selectedMedia.type === 'video' ? <Video size={18} /> : 
                                 selectedMedia.type === 'audio' ? <Mic size={18} /> : 
                                 <FileText size={18} />}
                              </div>
                            )}
                            <div className="flex flex-col">
                              <span className="text-[10px] font-bold text-blue-700 truncate max-w-[150px]">{selectedMedia.file.name}</span>
                              <span className="text-[8px] text-blue-500 uppercase font-bold tracking-wider">{selectedMedia.type}</span>
                            </div>
                          </div>
                          <button onClick={() => setSelectedMedia(null)} className="p-1.5 text-blue-400 hover:text-blue-600 hover:bg-blue-100 rounded-full transition-all">
                            <X size={16} />
                          </button>
                        </div>
                      )}
                      <div className="flex items-center gap-2 bg-gray-100 p-1 rounded-3xl">
                        {isRecordingVoice ? (
                          <VoiceRecorder 
                            onSend={handleVoiceSend} 
                            onCancel={() => setIsRecordingVoice(false)} 
                            isSending={isSending}
                          />
                        ) : (
                          <>
                            <label className="w-10 h-10 flex items-center justify-center text-gray-500 hover:text-blue-600 hover:bg-white rounded-full cursor-pointer transition-all">
                              <Paperclip size={20} />
                              <input type="file" className="hidden" onChange={handleFileSelect} accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx" />
                            </label>
                            <button 
                              type="button" 
                              onClick={() => setIsRecordingVoice(true)} 
                              disabled={isSending} 
                              className="w-10 h-10 flex items-center justify-center rounded-full text-gray-500 hover:text-emerald-600 hover:bg-white transition-all"
                            >
                              <Mic size={20} />
                            </button>
                            <textarea 
                              placeholder="Type a message..."
                              className="flex-1 bg-transparent border-none rounded-2xl text-sm p-2.5 focus:ring-0 resize-none h-10 max-h-32 custom-scrollbar"
                              value={replyText}
                              onChange={e => setReplyText(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                  e.preventDefault();
                                  handleSendReply();
                                }
                              }}
                            />
                            <button 
                              onClick={handleSendReply}
                              disabled={isSending || (!replyText.trim() && !selectedMedia)}
                              className="w-10 h-10 bg-emerald-500 text-white rounded-full flex items-center justify-center disabled:opacity-50 active:scale-95 transition-all shadow-lg shadow-emerald-200"
                            >
                              {isSending ? <Loader2 className="animate-spin" size={20} /> : <Send size={20} />}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* Action Form */}
              <div className="p-4">
                <div className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm space-y-4">
                  <h4 className="text-sm font-bold text-gray-900 flex items-center gap-2">
                    <History size={16} className="text-blue-600" />
                    Log Interaction
                  </h4>
                  
                  <div className="space-y-3">
                    <select 
                      className="w-full px-4 py-3 rounded-2xl bg-gray-50 border-none text-sm focus:ring-2 focus:ring-blue-500 transition-all"
                      value={actionStatus}
                      onChange={e => setActionStatus(e.target.value)}
                    >
                      <option value="">Select Status (Required)</option>
                      <option value="followed_up">Followed Up</option>
                      <option value="interested">Interested</option>
                      <option value="not_interested">Not Interested</option>
                      <option value="booked">Booked / Closed</option>
                      <option value="no_answer">No Answer</option>
                    </select>

                    <textarea 
                      placeholder="Add a note about this interaction... (Required)"
                      className="w-full px-4 py-3 rounded-2xl bg-gray-50 border-none text-sm focus:ring-2 focus:ring-blue-500 transition-all min-h-[100px] resize-none"
                      value={actionNote}
                      onChange={e => setActionNote(e.target.value)}
                    />

                    <div className="space-y-1">
                      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-1">Next Follow-up (Optional)</p>
                      <input 
                        type="datetime-local"
                        className="w-full px-4 py-3 rounded-2xl bg-gray-50 border-none text-sm focus:ring-2 focus:ring-blue-500 transition-all"
                        value={nextFollowup}
                        onChange={e => setNextFollowup(e.target.value)}
                      />
                    </div>

                    {actionStatus === 'booked' && (
                      <div className="space-y-2 animate-in slide-in-from-top-2">
                        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Closing Screenshot Required</p>
                        <div className="flex items-center gap-3">
                          <label className="flex-1 flex flex-col items-center justify-center gap-2 p-4 border-2 border-dashed border-gray-200 rounded-2xl hover:border-blue-400 hover:bg-blue-50 transition-all cursor-pointer">
                            {closingScreenshot ? (
                              <div className="relative w-full h-20">
                                <img src={closingScreenshot.preview} className="w-full h-full object-cover rounded-xl" alt="Closing" />
                                <button 
                                  onClick={(e) => { e.preventDefault(); setClosingScreenshot(null); }}
                                  className="absolute -top-2 -right-2 bg-red-500 text-white p-1 rounded-full shadow-lg"
                                >
                                  <X size={12} />
                                </button>
                              </div>
                            ) : (
                              <>
                                <Paperclip size={24} className="text-gray-400" />
                                <span className="text-[10px] font-bold text-gray-500 uppercase">Attach Screenshot</span>
                              </>
                            )}
                            <input 
                              type="file" 
                              className="hidden" 
                              accept="image/*" 
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) setClosingScreenshot({ file, preview: URL.createObjectURL(file) });
                              }} 
                            />
                          </label>
                        </div>
                      </div>
                    )}

                    <p className="text-[10px] text-gray-400 px-1">Status and note are required. Scheduled date is optional.</p>

                    <div className="grid grid-cols-1 gap-2">
                      <button 
                        onClick={() => handleLogAction('interaction')}
                        disabled={loading || !actionNote.trim() || !actionStatus}
                        className="w-full bg-black text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-2 disabled:opacity-50 active:scale-95 transition-all"
                      >
                        {loading ? <Loader2 className="animate-spin" size={20} /> : <><CheckCircle size={20} /> Save Interaction</>}
                      </button>
                      
                      {actionStatus === 'booked' && (
                        <button 
                          onClick={() => setShowReviewModal(true)}
                          className="w-full bg-blue-600 text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-2 disabled:opacity-50 active:scale-95 transition-all shadow-lg shadow-blue-200"
                        >
                          <Zap size={20} /> Submit for Closing Review
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Activity Timeline */}
              <div className="p-4 pb-10">
                <h4 className="text-sm font-bold text-gray-900 mb-4 px-1">Activity History</h4>
                <div className="space-y-4 relative before:absolute before:left-[19px] before:top-2 before:bottom-2 before:w-0.5 before:bg-gray-200">
                  {activities.map((activity) => {
                    const activityDetails = getActivityDetails(activity);

                    return (
                    <div key={activity.id} className="relative pl-10">
                      <div className="absolute left-0 top-1 w-10 h-10 rounded-full bg-white border-2 border-gray-200 flex items-center justify-center z-10">
                        <div className="w-2 h-2 rounded-full bg-blue-600" />
                      </div>
                      <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm">
                        <div className="flex justify-between items-start mb-1">
                          <p className="text-xs font-bold text-gray-900 uppercase tracking-wider">{activity.action.replace(/_/g, ' ')}</p>
                          <p className="text-[10px] text-gray-400">{formatTimelineTime(activity.created_at)}</p>
                        </div>
                        <div className="mt-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2">
                          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Note</p>
                          <p className="text-sm text-gray-700 leading-relaxed mt-1">{activity.notes || 'No notes added.'}</p>
                        </div>
                        <div className="mt-3 space-y-2">
                          {activityDetails.map((detail) => (
                            <div
                              key={`${activity.id}-${detail.label}`}
                              className={`rounded-xl px-3 py-2 ${
                                detail.tone === 'blue'
                                  ? 'border border-blue-100 bg-blue-50/60'
                                  : 'border border-violet-100 bg-violet-50/60'
                              }`}
                            >
                              <p className={`text-[10px] font-bold uppercase tracking-wider ${detail.tone === 'blue' ? 'text-blue-700' : 'text-violet-700'}`}>
                                {detail.label}
                              </p>
                              <p className={`text-xs mt-1 ${detail.tone === 'blue' ? 'text-blue-900' : 'text-violet-900'}`}>{detail.value}</p>
                            </div>
                          ))}
                        </div>
                        {(activity as any).media_url && (
                          <div className="mt-3 rounded-xl overflow-hidden border border-gray-100">
                            <img src={(activity as any).media_url} alt="Activity Media" className="max-w-full h-auto" referrerPolicy="no-referrer" />
                          </div>
                        )}
                        <p className="text-[10px] text-gray-400 mt-2 font-medium italic">Logged by {activity.staff_name}</p>
                      </div>
                    </div>
                    );
                  })}
                  {activities.length === 0 && (
                    <div className="text-center py-10 bg-white rounded-3xl border border-gray-100">
                      <p className="text-xs text-gray-400">No activity logged yet.</p>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  const renderTeam = () => (
    <div className="flex flex-col h-full animate-in slide-in-from-right duration-300">
      <div className="p-4 bg-white border-b border-gray-100 sticky top-0 z-10">
        <div className="flex items-center gap-3 mb-4">
          <button onClick={() => setView('dashboard')} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
            <ArrowLeft size={20} />
          </button>
          <h2 className="text-lg font-bold">My Team</h2>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {teamStaff.map(staff => {
          const staffLeads = allLeads.filter(l => (l as any).assigned_to === staff.id);
          const closedLeads = staffLeads.filter(l => (l as any).lead_status === 'booked');
          
          return (
            <div key={staff.id} className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-2xl bg-gray-100 text-gray-600 flex items-center justify-center font-bold text-xl">
                    {staff.name.charAt(0)}
                  </div>
                  <div>
                    <h4 className="font-bold text-gray-900">{staff.name}</h4>
                    <p className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">{staff.role}</p>
                  </div>
                </div>
                <div className="text-right">
                  <div className="flex items-center gap-1 text-emerald-600 font-bold text-xs">
                    <CheckCircle size={12} />
                    {closedLeads.length} Closed
                  </div>
                  <p className="text-[10px] text-gray-400 mt-0.5">{staffLeads.length} Active Leads</p>
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-gray-50 p-3 rounded-2xl text-center">
                  <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Performance</p>
                  <p className="text-sm font-bold text-gray-900 mt-1">
                    {staffLeads.length > 0 ? Math.round((closedLeads.length / staffLeads.length) * 100) : 0}%
                  </p>
                </div>
                <div className="bg-gray-50 p-3 rounded-2xl text-center">
                  <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Status</p>
                  <p className={`text-sm font-bold mt-1 ${staff.is_active_for_auto_dist ? 'text-emerald-600' : 'text-gray-400'}`}>
                    {staff.is_active_for_auto_dist ? 'Online' : 'Offline'}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
        {teamStaff.length === 0 && (
          <div className="text-center py-20">
            <div className="bg-gray-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <Users size={32} className="text-gray-300" />
            </div>
            <p className="text-gray-500 font-medium">No staff members assigned to your team.</p>
          </div>
        )}
      </div>
    </div>
  );

  const renderManagerWorkspace = () => {
    const managerTabs = [
      { key: 'team-leads', label: 'Team Leads', icon: ClipboardList },
      { key: 'team-members', label: 'Team Members', icon: UserCog },
      { key: 'assignments', label: 'Assignments', icon: ListFilter },
      { key: 'reports', label: 'Reports', icon: TrendingUp },
      { key: 'audit', label: 'Audit', icon: ShieldCheck }
    ] as const;

    const staffLoad = teamStaff.map((staff) => {
      const leads = allLeads.filter((lead) => (lead as any).assigned_to === staff.id);
      const overdue = leads.filter((lead) => {
        const followup = (lead as any).next_followup_at;
        return followup && new Date(followup).getTime() < Date.now();
      }).length;
      const booked = leads.filter((lead) => (lead as any).lead_status === 'booked').length;
      return { staff, leads: leads.length, overdue, booked };
    });
    const reportStaffLoad = teamStaff.map((staff) => {
      const leads = scopedReportLeads.filter((lead) => (lead as any).assigned_to === staff.id);
      const overdue = leads.filter((lead) => {
        const followup = (lead as any).next_followup_at;
        return followup && new Date(followup).getTime() < Date.now();
      }).length;
      const booked = leads.filter((lead) => (lead as any).lead_status === 'booked').length;
      return { staff, leads: leads.length, overdue, booked };
    });

    const totalTeamLeads = scopedReportLeads.length;
    const unassignedLeads = scopedReportLeads.filter((lead) => !(lead as any).assigned_to).length;
    const overdueTeamLeads = scopedReportLeads.filter((lead) => {
      const followup = (lead as any).next_followup_at;
      return followup && new Date(followup).getTime() < Date.now();
    }).length;
    const bookedLeads = scopedReportLeads.filter((lead) => (lead as any).lead_status === 'booked').length;
    const auditActions = Array.from(new Set(managerAuditFeed.map((entry) => entry.action))).sort();
    const auditStaffMembers = Array.from(new Set(managerAuditFeed.map((entry) => entry.staff_name).filter(Boolean))).sort();

    return (
      <div className="h-full flex flex-col lg:flex-row animate-in fade-in duration-300">
        <aside className="hidden lg:flex lg:w-72 xl:w-80 bg-white border-r border-gray-200 p-5 flex-col gap-4">
          <div>
            <p className="text-[10px] font-bold text-blue-600 uppercase tracking-widest">Manager Workspace</p>
            <h2 className="text-xl font-bold text-gray-900 mt-1">Supervised Portal</h2>
            <p className="text-xs text-gray-500 mt-1">Monitor team health, rebalance workload, and close faster.</p>
          </div>
          <div className="space-y-2">
            {managerTabs.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setManagerTab(key)}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-2xl text-sm font-semibold transition-all ${
                  managerTab === key ? 'bg-black text-white shadow-lg' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                }`}
              >
                <span className="flex items-center gap-2">
                  <Icon size={16} />
                  {label}
                </span>
                <ChevronRight size={14} />
              </button>
            ))}
          </div>
        </aside>

        <div className="flex-1 min-h-0 flex flex-col">
          <div className="p-4 md:p-6 bg-white border-b border-gray-100 sticky top-0 z-10 space-y-4">
            <div className="flex items-center gap-3">
              <button onClick={() => setView('dashboard')} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
                <ArrowLeft size={20} />
              </button>
              <div>
                <h2 className="text-lg md:text-2xl font-bold text-gray-900">Manager Workspace</h2>
                <p className="text-xs text-gray-500">Desktop-grade supervision with mobile-optimized actions.</p>
              </div>
            </div>

            <div className="lg:hidden flex gap-2 overflow-x-auto pb-1">
              {managerTabs.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setManagerTab(key)}
                  className={`flex items-center gap-1.5 whitespace-nowrap px-3 py-2 rounded-xl text-xs font-bold ${
                    managerTab === key ? 'bg-black text-white' : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  <Icon size={14} />
                  {label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 md:gap-3">
              <div className="bg-blue-50 border border-blue-100 rounded-2xl p-3">
                <p className="text-[10px] uppercase font-bold tracking-wider text-blue-700">Team Leads</p>
                <p className="text-xl font-bold text-blue-900">{totalTeamLeads}</p>
              </div>
              <div className="bg-amber-50 border border-amber-100 rounded-2xl p-3">
                <p className="text-[10px] uppercase font-bold tracking-wider text-amber-700">Overdue</p>
                <p className="text-xl font-bold text-amber-900">{overdueTeamLeads}</p>
              </div>
              <div className="bg-violet-50 border border-violet-100 rounded-2xl p-3">
                <p className="text-[10px] uppercase font-bold tracking-wider text-violet-700">Unassigned</p>
                <p className="text-xl font-bold text-violet-900">{unassignedLeads}</p>
              </div>
              <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-3">
                <p className="text-[10px] uppercase font-bold tracking-wider text-emerald-700">Booked</p>
                <p className="text-xl font-bold text-emerald-900">{bookedLeads}</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Reporting Window</p>
              {(['7d', '30d', '90d'] as const).map((range) => (
                <button
                  key={range}
                  onClick={() => setReportRange(range)}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider ${
                    reportRange === range ? 'bg-black text-white' : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {range}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4">
            {managerTab === 'team-leads' && (
              <>
                <div className="bg-white rounded-2xl border border-gray-100 p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                  <select
                    className="px-3 py-2 rounded-xl bg-gray-50 text-sm border border-transparent focus:border-blue-300"
                    value={managerStaffFilter}
                    onChange={(e) => setManagerStaffFilter(e.target.value)}
                  >
                    <option value="all">All Staff</option>
                    {teamStaff.map((staff) => (
                      <option key={staff.id} value={staff.id}>{staff.name}</option>
                    ))}
                  </select>
                  <select
                    className="px-3 py-2 rounded-xl bg-gray-50 text-sm border border-transparent focus:border-blue-300"
                    value={managerStatusFilter}
                    onChange={(e) => setManagerStatusFilter(e.target.value as any)}
                  >
                    <option value="all">All Lead States</option>
                    <option value="overdue">Overdue Follow-ups</option>
                    <option value="unassigned">Unassigned</option>
                    <option value="booked">Booked</option>
                  </select>
                </div>

                <div className="hidden lg:block bg-white rounded-2xl border border-gray-100 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
                      <tr>
                        <th className="text-left p-3">Lead</th>
                        <th className="text-left p-3">Owner</th>
                        <th className="text-left p-3">Status</th>
                        <th className="text-left p-3">Follow-up</th>
                        <th className="text-right p-3">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredManagerLeads.slice(0, 60).map((lead) => {
                        const owner = teamStaff.find((staff) => staff.id === (lead as any).assigned_to)?.name || 'Unassigned';
                        const followup = (lead as any).next_followup_at;
                        const isOverdue = followup && new Date(followup).getTime() < Date.now();
                        return (
                          <tr key={lead.id} className="border-t border-gray-100">
                            <td className="p-3 font-semibold text-gray-900">{lead.name}</td>
                            <td className="p-3 text-gray-600">{owner}</td>
                            <td className="p-3 text-gray-600">{toLabel((lead as any).lead_status) || 'New'}</td>
                            <td className={`p-3 ${isOverdue ? 'text-red-600 font-semibold' : 'text-gray-600'}`}>{formatDateTime(followup)}</td>
                            <td className="p-3">
                              <div className="flex justify-end gap-2">
                                <button onClick={() => handleOpenDetail(lead)} className="px-3 py-1.5 rounded-lg bg-black text-white text-xs font-bold">Open</button>
                                {!(lead as any).assigned_to && teamStaff[0] && (
                                  <button onClick={() => handleStrategyAssign(lead.id)} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-bold">Smart Assign</button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="lg:hidden space-y-3">
                  {filteredManagerLeads.slice(0, 30).map((lead) => (
                    <div key={lead.id} className="bg-white rounded-2xl border border-gray-100 p-4">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-bold text-gray-900 truncate">{lead.name}</p>
                        <span className="text-[10px] uppercase tracking-wider font-bold text-gray-500">{toLabel((lead as any).lead_status)}</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-1">Owner: {teamStaff.find((staff) => staff.id === (lead as any).assigned_to)?.name || 'Unassigned'}</p>
                      <p className="text-xs text-gray-500">Follow-up: {formatDateTime((lead as any).next_followup_at)}</p>
                      <button onClick={() => handleOpenDetail(lead)} className="mt-3 w-full py-2 rounded-xl bg-black text-white text-xs font-bold">Open Lead</button>
                    </div>
                  ))}
                </div>
              </>
            )}

            {managerTab === 'team-members' && (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {staffLoad.map(({ staff, leads, overdue, booked }) => (
                  <div key={staff.id} className="bg-white border border-gray-100 rounded-2xl p-4">
                    <div className="flex items-center justify-between">
                      <h3 className="font-bold text-gray-900">{staff.name}</h3>
                      <span className={`text-[10px] px-2 py-1 rounded-full font-bold ${staff.is_active_for_auto_dist ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                        {staff.is_active_for_auto_dist ? 'Online' : 'Offline'}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 mt-3 text-center">
                      <div className="bg-gray-50 rounded-xl py-2">
                        <p className="text-[10px] text-gray-500 uppercase">Leads</p>
                        <p className="font-bold">{leads}</p>
                      </div>
                      <div className="bg-amber-50 rounded-xl py-2">
                        <p className="text-[10px] text-amber-600 uppercase">Overdue</p>
                        <p className="font-bold text-amber-700">{overdue}</p>
                      </div>
                      <div className="bg-emerald-50 rounded-xl py-2">
                        <p className="text-[10px] text-emerald-600 uppercase">Booked</p>
                        <p className="font-bold text-emerald-700">{booked}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {managerTab === 'assignments' && (
              <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-3">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                  <p className="text-sm font-bold text-gray-900">Quick Assignment Queue</p>
                  <select
                    className="px-3 py-2 rounded-xl bg-gray-50 text-xs font-semibold border border-transparent focus:border-blue-300"
                    value={assignmentStrategy}
                    onChange={(e) => setAssignmentStrategy(e.target.value as any)}
                  >
                    <option value="manual">Manual assignment</option>
                    <option value="least-loaded">Auto: Least loaded</option>
                    <option value="round-robin">Auto: Round robin</option>
                  </select>
                </div>
                {teamLeads.filter((lead) => !(lead as any).assigned_to).slice(0, 20).map((lead) => (
                  <div key={lead.id} className="p-3 rounded-xl bg-gray-50 flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                    <div>
                      <p className="font-semibold text-sm text-gray-900">{lead.name}</p>
                      <p className="text-xs text-gray-500">{(lead as any).phone_number || 'No phone'}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {assignmentStrategy !== 'manual' && (
                        <button onClick={() => handleStrategyAssign(lead.id)} className="px-3 py-1.5 rounded-lg bg-black text-white text-xs font-bold">
                          Auto Assign
                        </button>
                      )}
                      {teamStaff.slice(0, 4).map((staff) => (
                        <button key={staff.id} onClick={() => handleAssignLead(lead.id, staff.id)} className="px-3 py-1.5 rounded-lg bg-white border border-gray-200 text-xs font-bold hover:bg-blue-50 hover:border-blue-200">
                          Assign {staff.name.split(' ')[0]}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {managerTab === 'reports' && (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                {reportStaffLoad.map(({ staff, leads, overdue, booked }) => {
                  const conversion = leads > 0 ? Math.round((booked / leads) * 100) : 0;
                  return (
                    <div key={staff.id} className="bg-white border border-gray-100 rounded-2xl p-4">
                      <div className="flex items-center justify-between">
                        <p className="font-bold text-gray-900">{staff.name}</p>
                        <span className="text-[10px] px-2 py-1 rounded-full bg-blue-50 text-blue-700 font-bold uppercase">{reportRange}</span>
                      </div>
                      <div className="mt-3 space-y-2">
                        <div className="flex justify-between text-xs"><span>Total Leads</span><span className="font-bold">{leads}</span></div>
                        <div className="flex justify-between text-xs"><span>Booked</span><span className="font-bold text-emerald-700">{booked}</span></div>
                        <div className="flex justify-between text-xs"><span>Overdue</span><span className="font-bold text-amber-700">{overdue}</span></div>
                        <div className="flex justify-between text-xs"><span>Conversion</span><span className="font-bold text-blue-700">{conversion}%</span></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {managerTab === 'audit' && (
              <div className="bg-white rounded-2xl border border-gray-100 p-4">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-3">
                  <p className="text-sm font-bold text-gray-900">Latest Team Activity</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <select
                      className="px-3 py-2 rounded-xl bg-gray-50 text-xs border border-transparent focus:border-blue-300"
                      value={auditActionFilter}
                      onChange={(e) => setAuditActionFilter(e.target.value)}
                    >
                      <option value="all">All actions</option>
                      {auditActions.map((action) => (
                        <option key={action} value={action}>{toLabel(action)}</option>
                      ))}
                    </select>
                    <select
                      className="px-3 py-2 rounded-xl bg-gray-50 text-xs border border-transparent focus:border-blue-300"
                      value={auditStaffFilter}
                      onChange={(e) => setAuditStaffFilter(e.target.value)}
                    >
                      <option value="all">All staff</option>
                      {auditStaffMembers.map((staffName) => (
                        <option key={staffName} value={staffName}>{staffName}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="space-y-2">
                  {auditLoading && (
                    <div className="py-6 flex items-center justify-center text-gray-500 text-sm">
                      <Loader2 className="animate-spin mr-2" size={16} />
                      Loading audit feed...
                    </div>
                  )}
                  {!auditLoading && filteredAuditFeed.slice(0, 20).map((activity) => (
                    <div key={activity.id} className="p-3 rounded-xl bg-gray-50">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-bold uppercase tracking-wide text-gray-700">{activity.action.replace(/_/g, ' ')}</p>
                        <p className="text-[10px] text-gray-500">{formatDateTime(activity.created_at)}</p>
                      </div>
                      <p className="text-xs text-gray-600 mt-1 line-clamp-2">{activity.notes || 'No note provided.'}</p>
                      <p className="text-[10px] text-gray-400 mt-1">by {activity.staff_name || 'System'}</p>
                    </div>
                  ))}
                  {!auditLoading && filteredAuditFeed.length === 0 && (
                    <div className="py-10 text-center text-gray-500 text-sm flex flex-col items-center gap-2">
                      <AlertTriangle size={18} />
                      No audit activity matches the selected filters.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={`min-h-screen bg-gray-50 flex flex-col font-sans mx-auto border-gray-200 ${isManagerRole ? 'max-w-[1400px] lg:border-x lg:shadow-xl' : 'max-w-md border-x shadow-2xl'}`}>
      {/* Top Bar */}
      {view !== 'detail' && (
        <header className="bg-white px-4 md:px-6 py-4 border-b border-gray-100 flex items-center justify-between sticky top-0 z-20">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-black text-white flex items-center justify-center font-bold">
              E
            </div>
            <div>
              <h1 className="text-sm font-bold text-gray-900">{isManagerRole ? 'Encho Workspace' : 'Encho Staff'}</h1>
              <p className="text-[10px] text-emerald-600 font-bold uppercase tracking-widest flex items-center gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Online
              </p>
            </div>
          </div>
          <button onClick={onLogout} className="p-2 text-gray-400 hover:text-red-600 transition-colors">
            <LogOut size={20} />
          </button>
        </header>
      )}

      {/* Content Area */}
      <main className="flex-1 overflow-hidden">
        {view === 'dashboard' && renderDashboard()}
        {view === 'pool' && renderLeadList(true)}
        {view === 'my-leads' && renderLeadList(false)}
        {view === 'detail' && renderDetail()}
        {view === 'team' && renderTeam()}
        {view === 'action-center' && (
          <div className="flex flex-col h-full animate-in slide-in-from-right duration-300">
            <div className="p-4 bg-white border-b border-gray-100 sticky top-0 z-10">
              <div className="flex items-center gap-3 mb-4">
                <button onClick={() => setView('dashboard')} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
                  <ArrowLeft size={20} />
                </button>
                <h2 className="text-lg font-bold">Action Center</h2>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              <ActionCenter 
                staffId={user.staffId} 
                onSelectLead={(id) => {
                  const lead = allLeads.find(l => l.id === id);
                  if (lead) handleOpenDetail(lead);
                }} 
              />
            </div>
          </div>
        )}
        {view === 'command-center' && (
          <CommandCenter managerId={user.staffId} onBack={() => setView('dashboard')} />
        )}
        {view === 'pending-reviews' && (
          <PendingReviews managerId={user.staffId} onBack={() => setView('dashboard')} />
        )}
        {view === 'manager-workspace' && isManagerRole && renderManagerWorkspace()}
      </main>

      {/* Modals */}
      {showReviewModal && selectedLead && (
        <LeadReviewModal 
          lead={selectedLead} 
          onClose={() => setShowReviewModal(false)}
          onSuccess={() => {
            setShowReviewModal(false);
            setView('my-leads');
            // Refresh leads
            liveApiService.getDrivers().then(setAllLeads);
          }}
        />
      )}

      {/* Bottom Navigation */}
      {view !== 'detail' && (
        <nav className="bg-white border-t border-gray-100 px-4 md:px-6 py-3 flex items-center justify-around sticky bottom-0 z-20 pb-8">
          <button 
            onClick={() => setView('dashboard')}
            className={`flex flex-col items-center gap-1 transition-all ${view === 'dashboard' ? 'text-blue-600' : 'text-gray-400'}`}
          >
            <LayoutDashboard size={20} />
            <span className="text-[10px] font-bold uppercase tracking-widest">Home</span>
          </button>
          <button 
            onClick={() => setView('pool')}
            className={`flex flex-col items-center gap-1 transition-all ${view === 'pool' ? 'text-blue-600' : 'text-gray-400'}`}
          >
            <Zap size={20} />
            <span className="text-[10px] font-bold uppercase tracking-widest">Pool</span>
          </button>
          <button 
            onClick={() => setView('my-leads')}
            className={`flex flex-col items-center gap-1 transition-all ${view === 'my-leads' ? 'text-blue-600' : 'text-gray-400'}`}
          >
            <Users size={20} />
            <span className="text-[10px] font-bold uppercase tracking-widest">Leads</span>
          </button>
          {(user.role === 'manager' || user.role === 'admin') && (
            <button 
              onClick={() => setView('manager-workspace')}
              className={`flex flex-col items-center gap-1 transition-all ${view === 'manager-workspace' ? 'text-blue-600' : 'text-gray-400'}`}
            >
              <UserCog size={20} className="stroke-[2.5px]" />
              <span className="text-[10px] font-bold uppercase tracking-widest">Manage</span>
            </button>
          )}
        </nav>
      )}

      {/* Error Toast */}
      {error && (
        <div className="fixed bottom-24 left-4 right-4 bg-red-600 text-white p-4 rounded-2xl shadow-2xl flex items-center gap-3 animate-in slide-in-from-bottom-10 z-50">
          <AlertCircle size={20} />
          <p className="text-xs font-bold flex-1">{error}</p>
          <button onClick={() => setError(null)} className="text-white/60 hover:text-white">
            <X size={16} />
          </button>
        </div>
      )}

      <ScheduledAlertPopup
        alert={activeDueAlert}
        onDismiss={() => dismissDueAlert(activeDueAlert?.event_id)}
        onOpenLead={(leadId) => {
          const lead = allLeads.find(l => l.id === leadId);
          if (lead) {
            handleOpenDetail(lead);
          }
        }}
      />
    </div>
  );
};
