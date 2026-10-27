
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
  AlertTriangle,
  Eye,
  Lock,
  PhoneCall,
  PhoneOff,
  PhoneForwarded
} from 'lucide-react';
import { liveApiService } from '../services/liveApiService.ts';
import { getLeadScreenshotUploadPath } from '../services/mediaPaths';
import { Driver, Message, CannedResponse, ActiveLeadViewer, LeadCall } from '../types.ts';
import { VoiceRecorder } from './VoiceRecorder.tsx';
import { ActionCenter } from './ActionCenter.tsx';
import { CommandCenter } from './CommandCenter.tsx';
import { PendingReviews } from './PendingReviews.tsx';
import { LeadReviewModal } from './LeadReviewModal.tsx';
import { ScheduledAlertPopup } from './ScheduledAlertPopup.tsx';
import { DueAlertItem } from '../services/liveApiService.ts';

const getDueAlertInstanceId = (alert: DueAlertItem) => `${alert.event_id}:${new Date(alert.scheduled_at).toISOString()}`;

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
  const [monitoredStaffId, setMonitoredStaffId] = useState<string | null>(null);
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
  const authoritativeLeadsRef = React.useRef<Map<string, any>>(new Map());

  // FAANG Agent Workspace: Collision, Whisper Notes & Recruiter Macros
  const [activeViewers, setActiveViewers] = useState<ActiveLeadViewer[]>([]);
  const [isInternalNoteMode, setIsInternalNoteMode] = useState<boolean>(false);
  const [cannedResponses, setCannedResponses] = useState<CannedResponse[]>([]);
  const [showMacrosMenu, setShowMacrosMenu] = useState<boolean>(false);

  // FAANG Shift Presence & Mouse-Idle Engine
  const [presenceStatus, setPresenceStatus] = useState<'online' | 'away'>('online');
  const lastActivityRef = React.useRef<number>(Date.now());

  // FAANG In-Browser Telephony CTI Call Logger
  const [showCallModal, setShowCallModal] = useState<boolean>(false);
  const [callActive, setCallActive] = useState<boolean>(false);
  const [callSeconds, setCallSeconds] = useState<number>(0);
  const [callDisposition, setCallDisposition] = useState<string>('Connected - Interested');
  const [callNotes, setCallNotes] = useState<string>('');
  const [isSubmittingCall, setIsSubmittingCall] = useState<boolean>(false);

  const parseDateValue = (value?: string | number | null) => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'number') {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    const trimmed = String(value).trim();
    const numericValue = Number(trimmed);
    const parsed = Number.isFinite(numericValue) && /^\d+$/.test(trimmed)
      ? new Date(numericValue)
      : new Date(trimmed);

    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const getLeadFreshnessTimestamp = (lead: Driver) => (
    parseDateValue((lead as any).last_message_at || (lead as any).lastMessageAt)?.getTime()
    || parseDateValue((lead as any).created_at)?.getTime()
    || 0
  );

  const formatDateTime = (value?: string | number | null) => {
    const parsed = parseDateValue(value);
    return parsed ? parsed.toLocaleString() : '—';
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
      if (isInternalNoteMode) {
        // Send as Internal Team Note (Bypasses WhatsApp / Meta)
        await liveApiService.sendMessage(selectedLead.id, replyText, {
          isInternal: true
        });
        setReplyText('');
        const messages = await liveApiService.getDriverMessages(selectedLead.id);
        setLeadMessages(messages);
        return;
      }

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

  const handleSelectMacro = (macro: CannedResponse) => {
    if (!selectedLead) return;
    const interpolated = macro.body
      .replace(/\{\{name\}\}/gi, selectedLead.name || 'Driver')
      .replace(/\{\{phone\}\}/gi, (selectedLead as any).phone_number || selectedLead.phoneNumber || '');
    setReplyText(interpolated);
    setShowMacrosMenu(false);
  };

  const getLeadSlaBadge = (lead: Driver) => {
    const status = ((lead as any).lead_status || '').toLowerCase();
    if (!['claimed', 'assigned'].includes(status)) return null;

    const claimedAt = (lead as any).claimed_at || (lead as any).last_action_at || (lead as any).created_at;
    if (!claimedAt) return null;

    const elapsedMinutes = Math.floor((Date.now() - new Date(claimedAt).getTime()) / 60000);
    const TARGET_FRT_MINUTES = 15;

    if (elapsedMinutes > TARGET_FRT_MINUTES) {
      const overdue = elapsedMinutes - TARGET_FRT_MINUTES;
      return {
        label: `⚠️ SLA Overdue (+${overdue}m)`,
        className: 'bg-red-500/10 text-red-600 border border-red-200 animate-pulse font-bold'
      };
    } else {
      const remaining = TARGET_FRT_MINUTES - elapsedMinutes;
      const isUrgent = remaining <= 5;
      return {
        label: `⏱️ ${remaining}m FRT SLA`,
        className: isUrgent
          ? 'bg-amber-500/10 text-amber-700 border border-amber-200 font-semibold'
          : 'bg-emerald-500/10 text-emerald-700 border border-emerald-200 font-semibold'
      };
    }
  };

  // Live Call Timer Effect
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (callActive) {
      timer = setInterval(() => {
        setCallSeconds(prev => prev + 1);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [callActive]);

  // Mouse & Keyboard Inactivity Auto-Away Engine
  useEffect(() => {
    const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

    const onUserActivity = () => {
      lastActivityRef.current = Date.now();
      if (presenceStatus === 'away') {
        setPresenceStatus('online');
        liveApiService.updateStaffStatus('online').catch(() => null);
      }
    };

    window.addEventListener('mousemove', onUserActivity, { passive: true });
    window.addEventListener('keydown', onUserActivity, { passive: true });
    window.addEventListener('touchstart', onUserActivity, { passive: true });
    window.addEventListener('scroll', onUserActivity, { passive: true });
    window.addEventListener('click', onUserActivity, { passive: true });

    const checker = setInterval(() => {
      const idleTime = Date.now() - lastActivityRef.current;
      if (idleTime >= INACTIVITY_TIMEOUT_MS && presenceStatus === 'online') {
        setPresenceStatus('away');
        liveApiService.updateStaffStatus('away', 0, Math.round(idleTime / 1000)).catch(() => null);
      }
    }, 15000);

    return () => {
      window.removeEventListener('mousemove', onUserActivity);
      window.removeEventListener('keydown', onUserActivity);
      window.removeEventListener('touchstart', onUserActivity);
      window.removeEventListener('scroll', onUserActivity);
      window.removeEventListener('click', onUserActivity);
      clearInterval(checker);
    };
  }, [presenceStatus]);

  const handleStartCallModal = (lead: Driver) => {
    setCallSeconds(0);
    setCallActive(true);
    setCallDisposition('Connected - Interested');
    setCallNotes('');
    setShowCallModal(true);
  };

  const handleSaveCallLog = async () => {
    if (!selectedLead) return;
    setIsSubmittingCall(true);
    try {
      await liveApiService.logLeadCall(selectedLead.id, {
        durationSeconds: callSeconds,
        disposition: callDisposition,
        notes: callNotes,
        phoneNumber: selectedLead.phone_number
      });
      setShowCallModal(false);
      setCallSeconds(0);
      setCallActive(false);
      const acts = await liveApiService.getLeadActivity(selectedLead.id);
      setActivities(acts);
    } catch (err) {
      console.error('Failed to log call:', err);
    } finally {
      setIsSubmittingCall(false);
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
    allLeads
      .filter(l => !(l as any).assigned_to)
      .sort((a, b) => getLeadFreshnessTimestamp(b) - getLeadFreshnessTimestamp(a)),
    [allLeads]
  );

  const freshClaimedLeads = React.useMemo(
    () => myLeads
      .filter((lead) => ['claimed', 'assigned', 'new'].includes(((lead as any).lead_status || '').toLowerCase()))
      .sort((a, b) => new Date((b as any).claimed_at || (b as any).created_at || 0).getTime() - new Date((a as any).claimed_at || (a as any).created_at || 0).getTime()),
    [myLeads]
  );

  const prioritizedReminders = React.useMemo(() => {
    const now = Date.now();
    const toTs = (value?: string) => new Date(value || 0).getTime();
    return [...reminders].sort((a, b) => {
      const aTs = toTs(a.scheduled_at);
      const bTs = toTs(b.scheduled_at);
      const aOverdue = aTs < now;
      const bOverdue = bTs < now;
      if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
      return aTs - bTs;
    });
  }, [reminders]);

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

  const refreshOwnedLeadViews = React.useCallback(async () => {
    try {
      const [my, pool] = await Promise.all([
        liveApiService.getMyLeads(),
        liveApiService.getLeadPool()
      ]);
      const authoritative = new Map<string, any>();
      [...pool, ...my].forEach((lead: any) => authoritative.set(lead.id, lead));
      authoritativeLeadsRef.current = authoritative;
      setAllLeads((prev) => {
        const byId = new Map<string, any>();
        prev.forEach((lead: any) => byId.set(lead.id, lead));
        [...pool, ...my].forEach((lead: any) => {
          byId.set(lead.id, { ...(byId.get(lead.id) || {}), ...lead });
        });
        return Array.from(byId.values());
      });
    } catch (err) {
      console.error('Failed to refresh staff-owned lead views', err);
    }
  }, []);

  // Background Telemetry Pinger (God-Eye Engine)
  useEffect(() => {
    let lastActivity = Date.now();
    let activeSeconds = 0;
    let idleSeconds = 0;

    const updateActivity = () => { lastActivity = Date.now(); };
    window.addEventListener('mousemove', updateActivity);
    window.addEventListener('keydown', updateActivity);
    window.addEventListener('click', updateActivity);
    window.addEventListener('scroll', updateActivity);

    const heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const isIdle = (now - lastActivity) > 5 * 60 * 1000; // 5 minutes idle threshold

      if (isIdle) {
        idleSeconds += 30;
      } else {
        activeSeconds += 30;
      }

      liveApiService.sendHeartbeat(isIdle ? 'idle' : 'online', activeSeconds, idleSeconds)
        .then(() => {
          // Reset counters after successful sync
          activeSeconds = 0;
          idleSeconds = 0;
        })
        .catch(err => console.error('Telemetry ping failed', err));
    }, 30000); // Ping every 30 seconds

    return () => {
      window.removeEventListener('mousemove', updateActivity);
      window.removeEventListener('keydown', updateActivity);
      window.removeEventListener('click', updateActivity);
      window.removeEventListener('scroll', updateActivity);
      clearInterval(heartbeatInterval);
    };
  }, []);

  useEffect(() => {
    const unsubscribe = liveApiService.subscribeToUpdates(
      (drivers) => {
        // Stream payload can be windowed/truncated. Always merge with authoritative
        // role-scoped leads that were fetched from /leads/my and /leads/pool.
        setAllLeads((prev) => {
          const merged = new Map<string, any>();
          prev.forEach((lead: any) => merged.set(lead.id, lead));
          drivers.forEach((lead: any) => {
            merged.set(lead.id, { ...(merged.get(lead.id) || {}), ...lead });
          });
          return Array.from(merged.values());
        });
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

  // Adaptive fallback refresh: only polls if push SSE stream is disconnected/reconnecting
  useEffect(() => {
    if (!selectedLead?.id || view !== 'detail') return;
    if (connectionState === 'connected') return;

    const liveInterval = setInterval(async () => {
      try {
        const msgs = await liveApiService.getDriverMessages(selectedLead.id, 50);
        if (Array.isArray(msgs)) {
          setLeadMessages(prev => {
            if (msgs.length === 0) return prev;
            if (prev.length !== msgs.length) return msgs;
            const prevLast = prev[prev.length - 1];
            const newLast = msgs[msgs.length - 1];
            if (prevLast?.id !== newLast?.id || prevLast?.status !== newLast?.status) {
              return msgs;
            }
            return prev;
          });
        }
      } catch {}
    }, 5000);

    return () => clearInterval(liveInterval);
  }, [selectedLead?.id, view, connectionState]);

  useEffect(() => {
    refreshOwnedLeadViews();
    // Relaxed fallback interval: SSE stream handles instant real-time sync
    const timer = setInterval(refreshOwnedLeadViews, 60000);
    return () => clearInterval(timer);
  }, [refreshOwnedLeadViews]);

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

  // Active Lead Viewing Heartbeat (Agent Collision Detection)
  useEffect(() => {
    if (!selectedLead?.id) {
      setActiveViewers([]);
      return;
    }

    let isMounted = true;
    const leadId = selectedLead.id;

    liveApiService.notifyViewingLead(leadId)
      .then(res => {
        if (isMounted && res?.viewers) {
          setActiveViewers(res.viewers);
        }
      })
      .catch(err => console.error('[Collision Warning] Ping failed:', err));

    const interval = setInterval(() => {
      liveApiService.notifyViewingLead(leadId)
        .then(res => {
          if (isMounted && res?.viewers) {
            setActiveViewers(res.viewers);
          }
        })
        .catch(err => console.error('[Collision Warning] Heartbeat failed:', err));
    }, 15000);

    return () => {
      isMounted = false;
      clearInterval(interval);
      liveApiService.leaveViewingLead(leadId).catch(() => null);
    };
  }, [selectedLead?.id]);

  // Load Canned Responses & Macros
  useEffect(() => {
    liveApiService.getCannedResponses()
      .then(res => {
        if (Array.isArray(res)) setCannedResponses(res);
      })
      .catch(err => console.error('[Canned Responses] Load failed:', err));
  }, []);

  const handleClaim = async (id: string) => {
    try {
      setLoading(true);
      await liveApiService.claimLead(id);
      await refreshOwnedLeadViews();
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
        const fresh = alerts.filter(alert => !seenIds.has(getDueAlertInstanceId(alert)));
        if (fresh.length > 0) {
          setDueAlertQueue(prev => {
            const existing = new Set(prev.map(item => getDueAlertInstanceId(item)));
            if (activeDueAlert?.event_id) {
              existing.add(getDueAlertInstanceId(activeDueAlert));
            }
            return [...prev, ...fresh.filter(item => !existing.has(getDueAlertInstanceId(item)))];
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
    if (seenIds.has(getDueAlertInstanceId(next))) {
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
    if (activeDueAlert && activeDueAlert.event_id === eventId) {
      seenIds.add(getDueAlertInstanceId(activeDueAlert));
    }
    localStorage.setItem(seenKey, JSON.stringify(Array.from(seenIds)));
    setDueAlertQueue(prev => prev.filter(alert => {
      if (activeDueAlert && activeDueAlert.event_id === eventId) {
        return getDueAlertInstanceId(alert) !== getDueAlertInstanceId(activeDueAlert);
      }
      return alert.event_id !== eventId;
    }));
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
      await refreshOwnedLeadViews();
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

  const handleForceLogout = async (staffId: string) => {
    try {
      setLoading(true);
      await liveApiService.forceLogoutStaff(staffId);
      // Refresh staff list
      const staffRes = await liveApiService.getStaff();
      setTeamStaff(staffRes.filter((s: any) => s.manager_id === user?.staffId || s.id === user?.staffId));
    } catch (error) {
      console.error('Failed to force logout:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleReassignLead = async (leadId: string, staffId: string) => {
    try {
      setLoading(true);
      await liveApiService.reassignLead(leadId, staffId);
      setAssigningTo(null);
      await refreshOwnedLeadViews();
      if (selectedLead?.id === leadId) {
        const updated = allLeads.find(d => d.id === leadId);
        if (updated) setSelectedLead(updated);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };


  const handleUnclaimLead = async (leadId: string) => {
    try {
      setLoading(true);
      await liveApiService.unclaimLead(leadId);
      await refreshOwnedLeadViews();
      if (selectedLead?.id === leadId) {
        setSelectedLead(null);
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
            {prioritizedReminders.map(reminder => (
              <div key={reminder.id} className="bg-white/60 p-3 rounded-2xl flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-gray-900 truncate">{reminder.lead_name}</p>
                  <p className="text-[10px] text-gray-500 truncate">{reminder.title || 'Follow-up'}</p>
                  <p className={`text-[9px] font-bold mt-0.5 ${new Date(reminder.scheduled_at).getTime() < Date.now() ? 'text-red-600' : 'text-amber-600'}`}>
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
        {freshClaimedLeads.length > 0 && (
          <div className="mb-4 px-1">
            <h3 className="text-sm font-bold text-gray-900 mb-2">Fresh Claimed Leads</h3>
            <p className="text-xs text-gray-500">Prioritize first-response and quick follow-up on newly claimed leads.</p>
          </div>
        )}
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


  const getLeadPriority = (lead: Driver) => {
    const botResponses = (lead as any).bot_response_count || 0;
    const mediaSignals = (lead as any).driver_media_count || 0;
    const priorityScore = (lead as any).priority_score || 0;
    return {
      reason: `${botResponses} bot repl${botResponses === 1 ? 'y' : 'ies'} • ${mediaSignals} media signal${mediaSignals === 1 ? '' : 's'}`,
      score: priorityScore
    };
  };

  const getUploadedFileTypes = (lead: Driver) => {
    const rawTypes = Array.isArray((lead as any).uploaded_file_types) ? (lead as any).uploaded_file_types : [];
    return rawTypes
      .map((type: unknown) => String(type || '').trim().toLowerCase())
      .filter(Boolean)
      .filter((type: string, index: number, values: string[]) => values.indexOf(type) === index);
  };

  const getUploadedFilesLabel = (lead: Driver) => {
    const typeLabels: Record<string, string> = {
      image: 'Image',
      document: 'Document',
      video: 'Video',
      audio: 'Audio',
      voice: 'Voice note',
      sticker: 'Sticker'
    };
    const uploadedTypes = getUploadedFileTypes(lead);
    const uploadedCount = Number((lead as any).uploaded_file_count || (lead as any).driver_media_count || 0);

    if (uploadedTypes.length > 0) {
      return `Uploaded: ${uploadedTypes.map(type => typeLabels[type] || toLabel(type)).join(', ')}`;
    }

    if (uploadedCount > 0) {
      return `${uploadedCount} file${uploadedCount === 1 ? '' : 's'} uploaded`;
    }

    return null;
  };

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
                <div className="flex flex-col items-end gap-1">
                  <div className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                    (lead as any).lead_status === 'new' ? 'bg-green-100 text-green-700' :
                    (lead as any).lead_status === 'claimed' ? 'bg-blue-100 text-blue-700' :
                    'bg-gray-100 text-gray-700'
                  }`}>
                    {(lead as any).lead_status || 'New'}
                  </div>
                  {(() => {
                    const sla = getLeadSlaBadge(lead);
                    if (!sla) return null;
                    return (
                      <span className={`px-2 py-0.5 rounded-md text-[9px] ${sla.className}`}>
                        {sla.label}
                      </span>
                    );
                  })()}
                </div>
              </div>

              {isPool && (() => {
                const priority = getLeadPriority(lead);
                const uploadedFilesLabel = getUploadedFilesLabel(lead);
                const lastCustomerMessage = formatDateTime((lead as any).last_message_at || (lead as any).lastMessageAt);
                const isBotFlowCompleted = Boolean((lead as any).bot_flow_completed);

                return (
                  <div className="mb-3 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="px-2 py-1 rounded-full border text-[10px] font-bold tracking-wide bg-indigo-100 text-indigo-700 border-indigo-200">
                        Priority #{priority.score}
                      </span>
                      <span className="text-[10px] text-gray-500 font-semibold">{priority.reason}</span>
                    </div>

                    <div className="rounded-2xl border border-gray-100 bg-gray-50 p-3 space-y-2">
                      <div className="flex items-center gap-2 text-[11px] font-semibold text-gray-700">
                        <Clock size={13} className="text-blue-500" />
                        <span>Last customer message:</span>
                        <span className="ml-auto text-gray-900">{lastCustomerMessage}</span>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {uploadedFilesLabel && (
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-100 px-2.5 py-1 text-[10px] font-bold text-orange-700 border border-orange-200">
                            <Paperclip size={11} />
                            {uploadedFilesLabel}
                          </span>
                        )}
                        {isBotFlowCompleted && (
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-bold text-emerald-700 border border-emerald-200">
                            <CheckCircle size={11} />
                            Completed
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}

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
                {(() => {
                  const sla = getLeadSlaBadge(lead);
                  if (!sla) return null;
                  return (
                    <div className={`px-2 py-0.5 rounded-lg text-[10px] ${sla.className}`}>
                      {sla.label}
                    </div>
                  );
                })()}
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
                <button
                  onClick={() => handleStartCallModal(lead)}
                  className="flex flex-col items-center justify-center gap-2 p-4 bg-blue-50 text-blue-700 rounded-3xl border border-blue-100 active:scale-95 transition-all hover:bg-blue-100"
                >
                  <PhoneCall size={24} />
                  <span className="text-[10px] font-bold uppercase tracking-widest">Call & Log</span>
                </button>
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
                {/* Agent Collision Warning Banner */}
                {activeViewers.length > 0 && (
                  <div className="mb-3 px-4 py-2.5 bg-amber-500/10 border border-amber-300 rounded-2xl flex items-center justify-between text-amber-900 animate-pulse">
                    <div className="flex items-center gap-2">
                      <AlertTriangle size={16} className="text-amber-600 flex-shrink-0" />
                      <span className="text-xs font-semibold">
                        <strong>Collision Warning:</strong> {activeViewers.map(v => `${v.staffName} (${v.role})`).join(', ')} {activeViewers.length === 1 ? 'is' : 'are'} currently viewing this lead.
                      </span>
                    </div>
                    <span className="text-[10px] bg-amber-200 text-amber-900 px-2 py-0.5 rounded-full font-bold uppercase tracking-wider">Active</span>
                  </div>
                )}

                <div className="flex-1 space-y-4 overflow-y-auto max-h-[400px] pr-2 custom-scrollbar mb-4 p-2">
                  {leadMessages
                    .filter(m => (m as any).type !== 'variable_capture' && (m as any).direction !== 'system')
                    .map((msg, idx) => {
                      const hasMedia = (msg.type === 'image' || msg.type === 'sticker') && msg.imageUrl ||
                                       msg.type === 'video' && msg.videoUrl ||
                                       (msg.type === 'audio' || msg.type === 'voice') && msg.audioUrl ||
                                       msg.type === 'document' && msg.documentUrl;
                      const isJson = msg.text?.trim().startsWith('{');
                      let displayText = msg.text || '';
                      if (isJson) {
                        try {
                          const parsed = JSON.parse(msg.text || '{}');
                          displayText = parsed.caption || '';
                        } catch {
                          displayText = '';
                        }
                      }
                      if (!hasMedia && !displayText.trim()) return null;

                      // Dedicated Internal Team Note Rendering
                      if (msg.isInternal || msg.type === 'internal_note') {
                        return (
                          <div key={msg.id || idx} className="my-2 p-3 bg-amber-50/90 border border-amber-200 rounded-2xl text-amber-950 shadow-xs">
                            <div className="flex items-center justify-between mb-1 pb-1 border-b border-amber-200/60">
                              <div className="flex items-center gap-1.5 text-xs font-bold text-amber-800">
                                <Lock size={12} className="text-amber-700" />
                                <span>Internal Team Note</span>
                                <span className="text-[10px] uppercase font-semibold text-amber-700 bg-amber-200/60 px-1.5 py-0.2 rounded-md">
                                  {msg.senderType || 'Staff'}
                                </span>
                              </div>
                              <span className="text-[10px] text-amber-600 font-medium">
                                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </div>
                            <p className="text-xs leading-relaxed whitespace-pre-wrap font-medium">
                              {displayText}
                            </p>
                          </div>
                        );
                      }

                        return (
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
                                {displayText && (
                                  <p className="leading-relaxed whitespace-pre-wrap">
                                    {displayText}
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
                    );
                  })}
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
                  {!isWindowActive && !isInternalNoteMode ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-1 bg-gray-100 p-0.5 rounded-xl">
                          <button
                            type="button"
                            onClick={() => setIsInternalNoteMode(false)}
                            className="px-3 py-1 rounded-lg text-xs font-bold text-gray-400 cursor-not-allowed"
                            disabled
                          >
                            WhatsApp (Expired)
                          </button>
                          <button
                            type="button"
                            onClick={() => setIsInternalNoteMode(true)}
                            className="px-3 py-1 rounded-lg text-xs font-bold bg-amber-500 text-white shadow-xs flex items-center gap-1.5"
                          >
                            <Lock size={12} />
                            Internal Team Note
                          </button>
                        </div>
                      </div>
                      <div className="flex flex-col items-center justify-center py-4 px-4 bg-gray-50 rounded-2xl border border-dashed border-gray-200">
                        <History size={20} className="text-gray-400 mb-2" />
                        <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">24h Customer Window Expired</p>
                        <p className="text-[9px] text-gray-400 text-center mt-1">Direct WhatsApp reply is paused until driver messages. Switch to <strong>Internal Team Note</strong> to leave notes.</p>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {/* Mode Toggle & Macros Bar */}
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1 bg-gray-100 p-0.5 rounded-xl">
                          <button
                            type="button"
                            onClick={() => setIsInternalNoteMode(false)}
                            disabled={!isWindowActive}
                            className={`px-3 py-1 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                              !isInternalNoteMode
                                ? 'bg-white text-emerald-700 shadow-xs'
                                : isWindowActive ? 'text-gray-500 hover:text-gray-700' : 'text-gray-300 cursor-not-allowed'
                            }`}
                          >
                            <MessageSquare size={12} />
                            WhatsApp
                          </button>
                          <button
                            type="button"
                            onClick={() => setIsInternalNoteMode(true)}
                            className={`px-3 py-1 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                              isInternalNoteMode
                                ? 'bg-amber-500 text-white shadow-xs'
                                : 'text-gray-500 hover:text-gray-700'
                            }`}
                          >
                            <Lock size={12} />
                            Team Note
                          </button>
                        </div>

                        {/* Quick Macros Dropdown */}
                        {!isInternalNoteMode && cannedResponses.length > 0 && (
                          <div className="relative">
                            <button
                              type="button"
                              onClick={() => setShowMacrosMenu(!showMacrosMenu)}
                              className="px-2.5 py-1 text-xs font-bold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-xl border border-blue-200 flex items-center gap-1.5 transition-all"
                            >
                              <Zap size={12} className="text-blue-600" />
                              <span>Quick Macros</span>
                            </button>

                            {showMacrosMenu && (
                              <div className="absolute right-0 bottom-full mb-2 w-72 bg-white rounded-2xl shadow-xl border border-gray-200 p-2 z-50 animate-in fade-in zoom-in-95">
                                <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-gray-100 px-2">
                                  <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Recruitment Macros</span>
                                  <button onClick={() => setShowMacrosMenu(false)} className="text-gray-400 hover:text-gray-600">
                                    <X size={14} />
                                  </button>
                                </div>
                                <div className="max-h-48 overflow-y-auto space-y-1 custom-scrollbar">
                                  {cannedResponses.map((macro) => (
                                    <button
                                      key={macro.id}
                                      type="button"
                                      onClick={() => handleSelectMacro(macro)}
                                      className="w-full text-left p-2 rounded-xl hover:bg-blue-50 transition-colors group"
                                    >
                                      <div className="flex items-center justify-between">
                                        <span className="text-xs font-bold text-gray-900 group-hover:text-blue-700">{macro.title}</span>
                                        <span className="text-[9px] font-mono bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded uppercase">/{macro.shortcut}</span>
                                      </div>
                                      <p className="text-[10px] text-gray-500 truncate mt-0.5">{macro.body}</p>
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {selectedMedia && !isInternalNoteMode && (
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

                      <div className={`flex items-center gap-2 p-1 rounded-3xl transition-all ${
                        isInternalNoteMode 
                          ? 'bg-amber-50/80 border border-amber-300' 
                          : 'bg-gray-100'
                      }`}>
                        {isRecordingVoice ? (
                          <VoiceRecorder
                            onSend={handleVoiceSend}
                            onCancel={() => setIsRecordingVoice(false)}
                            isSending={isSending}
                          />
                        ) : (
                          <>
                            {!isInternalNoteMode && (
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
                              </>
                            )}
                            {isInternalNoteMode && (
                              <div className="w-9 h-9 ml-1 rounded-full bg-amber-200/70 text-amber-800 flex items-center justify-center flex-shrink-0">
                                <Lock size={16} />
                              </div>
                            )}
                            <textarea
                              placeholder={isInternalNoteMode ? "Write private team note (managers & team only, never sent to driver)..." : "Type a message..."}
                              className={`flex-1 bg-transparent border-none rounded-2xl text-sm p-2.5 focus:ring-0 resize-none h-10 max-h-32 custom-scrollbar ${
                                isInternalNoteMode ? 'text-amber-950 placeholder-amber-600/60' : 'text-gray-900 placeholder-gray-400'
                              }`}
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
                              className={`w-10 h-10 rounded-full flex items-center justify-center disabled:opacity-50 active:scale-95 transition-all shadow-md ${
                                isInternalNoteMode
                                  ? 'bg-amber-600 hover:bg-amber-700 text-white shadow-amber-200'
                                  : 'bg-emerald-500 hover:bg-emerald-600 text-white shadow-emerald-200'
                              }`}
                            >
                              {isSending ? <Loader2 className="animate-spin" size={20} /> : isInternalNoteMode ? <Lock size={16} /> : <Send size={20} />}
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
                          <div className="flex items-center gap-1.5">
                            {activity.action === 'phone_call' && (
                              <span className="p-1 rounded-md bg-emerald-50 text-emerald-600 inline-flex items-center">
                                <PhoneCall size={12} />
                              </span>
                            )}
                            <p className="text-xs font-bold text-gray-900 uppercase tracking-wider">{activity.action.replace(/_/g, ' ')}</p>
                          </div>
                          <p className="text-[10px] text-gray-400">{formatTimelineTime(activity.created_at)}</p>
                        </div>
                        {activity.action === 'phone_call' && (() => {
                          let meta: any = {};
                          try {
                            meta = typeof activity.metadata === 'string' ? JSON.parse(activity.metadata || '{}') : (activity.metadata || {});
                          } catch {
                            meta = {};
                          }
                          const durSecs = meta.duration_seconds || 0;
                          const minutes = Math.floor(durSecs / 60);
                          const seconds = durSecs % 60;
                          return (
                            <div className="flex flex-wrap items-center gap-2 mt-1 mb-2">
                              {meta.disposition && (
                                <span className="text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 px-2.5 py-0.5 rounded-full">
                                  {meta.disposition}
                                </span>
                              )}
                              <span className="text-[10px] font-semibold text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
                                Duration: {minutes}m {seconds.toString().padStart(2, '0')}s
                              </span>
                            </div>
                          );
                        })()}
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
                                {!!(lead as any).assigned_to && (
                                  <button onClick={() => handleUnclaimLead(lead.id)} className="px-3 py-1.5 rounded-lg bg-amber-500 text-white text-xs font-bold">Unclaim</button>
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
                      {!!(lead as any).assigned_to && (
                        <button onClick={() => handleUnclaimLead(lead.id)} className="mt-2 w-full py-2 rounded-xl bg-amber-500 text-white text-xs font-bold">Unclaim to Pool</button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            {managerTab === 'team-members' && (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {staffLoad.map(({ staff, leads, overdue, booked }) => {
                  const isOnline = staff.current_status === 'online';
                  const isIdle = staff.current_status === 'idle';
                  const activeMins = Math.floor((staff.active_seconds_today || 0) / 60);
                  const idleMins = Math.floor((staff.idle_seconds_today || 0) / 60);

                  return (
                    <div key={staff.id} className="bg-white border border-gray-100 rounded-2xl p-5 shadow-sm hover:shadow-md transition-all">
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <div className="relative">
                            <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-lg">
                              {staff.name.charAt(0).toUpperCase()}
                            </div>
                            <div className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-white ${isOnline ? 'bg-emerald-500' : isIdle ? 'bg-amber-400' : 'bg-gray-300'}`}></div>
                          </div>
                          <div>
                            <h3 className="font-bold text-gray-900">{staff.name}</h3>
                            <p className="text-xs text-gray-500 capitalize">{staff.current_status || 'Offline'}</p>
                          </div>
                        </div>
                        <span className={`text-[10px] px-2 py-1 rounded-full font-bold ${staff.is_active_for_auto_dist ? 'bg-blue-50 text-blue-600 border border-blue-100' : 'bg-gray-50 text-gray-500 border border-gray-100'}`}>
                          {staff.is_active_for_auto_dist ? 'Auto-Dist ON' : 'Auto-Dist OFF'}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-3 mb-4">
                        <div className="bg-gray-50 rounded-xl p-3 flex flex-col justify-center">
                          <p className="text-[10px] text-gray-500 uppercase font-semibold mb-1">Active Time</p>
                          <p className="font-bold text-gray-800 text-sm">{activeMins}m</p>
                        </div>
                        <div className="bg-gray-50 rounded-xl p-3 flex flex-col justify-center">
                          <p className="text-[10px] text-gray-500 uppercase font-semibold mb-1">Idle Time</p>
                          <p className="font-bold text-gray-800 text-sm">{idleMins}m</p>
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-2 text-center border-t border-gray-100 pt-4 mb-4">
                        <div>
                          <p className="text-[10px] text-gray-500 uppercase font-semibold">Leads</p>
                          <p className="font-bold text-gray-900">{leads}</p>
                        </div>
                        <div>
                          <p className="text-[10px] text-amber-600 uppercase font-semibold">Overdue</p>
                          <p className="font-bold text-amber-700">{overdue}</p>
                        </div>
                        <div>
                          <p className="text-[10px] text-emerald-600 uppercase font-semibold">Booked</p>
                          <p className="font-bold text-emerald-700">{booked}</p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 border-t border-gray-100 pt-4">
                        <button
                          onClick={() => {
                            setManagerStaffFilter(staff.id);
                            setManagerTab('assignments');
                          }}
                          className="flex-1 py-2 bg-blue-50 text-blue-700 rounded-xl text-xs font-bold hover:bg-blue-100 transition-colors flex items-center justify-center gap-1"
                        >
                          <Eye size={14} /> Monitor
                        </button>
                        <button
                          onClick={() => {
                            if (window.confirm(`Are you sure you want to force logout ${staff.name}?`)) {
                              handleForceLogout(staff.id);
                            }
                          }}
                          disabled={!isOnline && !isIdle}
                          className={`flex-1 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1 transition-colors ${
                            isOnline || isIdle
                              ? 'bg-red-50 text-red-700 hover:bg-red-100'
                              : 'bg-gray-50 text-gray-400 cursor-not-allowed'
                          }`}
                        >
                          <LogOut size={14} /> Force Logout
                        </button>
                      </div>
                    </div>
                  );
                })}
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
      {/* FAANG Mouse-Idle Away Banner */}
      {presenceStatus === 'away' && (
        <div className="bg-amber-500 text-white px-4 py-2.5 text-xs font-semibold flex items-center justify-between shadow-md z-40 animate-in slide-in-from-top duration-200 sticky top-0">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-white animate-ping" />
            <span>You are marked <strong>AWAY</strong> due to inactivity. Hot leads are bypassed to active staff.</span>
          </div>
          <button
            onClick={() => {
              lastActivityRef.current = Date.now();
              setPresenceStatus('online');
              liveApiService.updateStaffStatus('online').catch(() => null);
            }}
            className="px-3 py-1 bg-white text-amber-800 rounded-lg text-xs font-bold shadow hover:bg-amber-50 transition-colors"
          >
            Resume Online
          </button>
        </div>
      )}

      {/* Top Bar */}
      {view !== 'detail' && (
        <header className="bg-white px-4 md:px-6 py-4 border-b border-gray-100 flex items-center justify-between sticky top-0 z-20">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-black text-white flex items-center justify-center font-bold">
              E
            </div>
            <div>
              <h1 className="text-sm font-bold text-gray-900">{isManagerRole ? 'Encho Workspace' : 'Encho Staff'}</h1>
              <p className={`text-[10px] font-bold uppercase tracking-widest flex items-center gap-1 ${presenceStatus === 'online' ? 'text-emerald-600' : 'text-amber-600'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${presenceStatus === 'online' ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
                {presenceStatus === 'online' ? 'Online' : 'Away (Idle)'}
              </p>
            </div>
          </div>
          <button
            onClick={onLogout}
            title="Sign out"
            aria-label="Sign out of Encho"
            className="inline-flex items-center gap-2 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-xs font-bold text-red-600 transition-colors hover:border-red-200 hover:bg-red-100"
          >
            <LogOut size={18} />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </header>
      )}

      {view === 'detail' && (
        <button
          onClick={onLogout}
          title="Sign out"
          aria-label="Sign out of Encho"
          className="fixed right-4 top-4 z-30 inline-flex items-center gap-2 rounded-xl border border-red-100 bg-white/95 px-3 py-2 text-xs font-bold text-red-600 shadow-lg shadow-red-950/10 backdrop-blur transition-colors hover:border-red-200 hover:bg-red-50"
        >
          <LogOut size={18} />
          <span className="hidden sm:inline">Sign out</span>
        </button>
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

      {/* FAANG In-Browser Telephony CTI Call Logger Modal */}
      {showCallModal && selectedLead && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-3xl max-w-md w-full shadow-2xl overflow-hidden border border-gray-100 animate-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="bg-gradient-to-r from-blue-600 to-indigo-700 text-white p-6 relative">
              <button
                onClick={() => {
                  if (callActive && !confirm('Call timer is currently running. Stop timer and close modal?')) {
                    return;
                  }
                  setShowCallModal(false);
                  setCallActive(false);
                }}
                className="absolute top-4 right-4 p-2 text-white/80 hover:text-white rounded-full hover:bg-white/10 transition-colors"
              >
                <X size={20} />
              </button>
              <div className="flex items-center gap-3 mb-2">
                <div className="p-3 bg-white/20 rounded-2xl">
                  <PhoneCall size={24} className={callActive ? "animate-pulse" : ""} />
                </div>
                <div>
                  <h3 className="font-bold text-lg leading-tight">{selectedLead.name}</h3>
                  <p className="text-blue-100 text-xs font-medium">{selectedLead.phone_number}</p>
                </div>
              </div>
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-white/20">
                <span className="text-[10px] font-bold tracking-widest uppercase text-blue-200">
                  {callActive ? 'Live Call In Progress' : 'Call Ended / Ready to Log'}
                </span>
                <div className="font-mono text-xl font-bold tracking-wider">
                  {Math.floor(callSeconds / 60).toString().padStart(2, '0')}:{(callSeconds % 60).toString().padStart(2, '0')}
                </div>
              </div>
            </div>

            {/* Actions & Body */}
            <div className="p-6 space-y-5">
              <div className="grid grid-cols-2 gap-3">
                {callActive ? (
                  <button
                    type="button"
                    onClick={() => setCallActive(false)}
                    className="flex items-center justify-center gap-2 py-3 px-4 bg-red-600 hover:bg-red-700 text-white font-bold rounded-2xl text-xs transition-all shadow-md shadow-red-200"
                  >
                    <PhoneOff size={16} /> Stop Timer
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setCallActive(true)}
                    className="flex items-center justify-center gap-2 py-3 px-4 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-2xl text-xs transition-all shadow-md shadow-emerald-200"
                  >
                    <PhoneCall size={16} /> Resume Timer
                  </button>
                )}
                <a
                  href={`tel:${selectedLead.phone_number}`}
                  className="flex items-center justify-center gap-2 py-3 px-4 bg-gray-100 hover:bg-gray-200 text-gray-800 font-bold rounded-2xl text-xs transition-all"
                >
                  <PhoneForwarded size={16} /> Dial via Phone
                </a>
              </div>

              {/* Disposition Selector */}
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-2">
                  Call Outcome / Disposition
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    'Connected - Interested',
                    'Scheduled Hub Visit',
                    'Call Back Later',
                    'Busy / Unreachable',
                    'Wrong Number / Not Interested',
                    'Document Issue'
                  ].map((disp) => (
                    <button
                      key={disp}
                      type="button"
                      onClick={() => setCallDisposition(disp)}
                      className={`py-2 px-3 text-left rounded-xl text-xs font-semibold border transition-all ${
                        callDisposition === disp
                          ? 'border-blue-600 bg-blue-50 text-blue-700 font-bold shadow-sm'
                          : 'border-gray-200 hover:border-gray-300 text-gray-700'
                      }`}
                    >
                      {disp}
                    </button>
                  ))}
                </div>
              </div>

              {/* Call Notes */}
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1">
                  Recruiter Call Notes
                </label>
                <textarea
                  value={callNotes}
                  onChange={(e) => setCallNotes(e.target.value)}
                  placeholder="Key conversation notes, vehicle details, driver questions, or next steps..."
                  className="w-full h-24 p-3 bg-gray-50 border border-gray-200 rounded-2xl text-xs text-gray-800 placeholder-gray-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none transition-all"
                />
              </div>

              {/* Save Button */}
              <button
                type="button"
                onClick={handleSaveCallLog}
                disabled={isSubmittingCall}
                className="w-full py-3.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-2xl text-sm transition-all shadow-lg shadow-blue-200 flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {isSubmittingCall ? (
                  <>
                    <Loader2 size={16} className="animate-spin" /> Saving Call...
                  </>
                ) : (
                  <>
                    <CheckCircle size={16} /> Complete & Log Call ({Math.floor(callSeconds / 60)}m {callSeconds % 60}s)
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
