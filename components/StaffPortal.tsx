
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
  Bell,
  BarChart3,
  Library,
  ImageIcon,
  Check,
  Copy,
  Star
} from 'lucide-react';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell
} from 'recharts';
import { liveApiService } from '../services/liveApiService.ts';
import { Driver, Message } from '../types.ts';
import { VoiceRecorder } from './VoiceRecorder.tsx';
import { MediaLibrary } from './MediaLibrary.tsx';

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
}

export const StaffPortal: React.FC<{ user: any; onLogout: () => void }> = ({ user, onLogout }) => {
  const [view, setView] = useState<'dashboard' | 'pool' | 'my-leads' | 'detail' | 'team' | 'media'>('dashboard');
  const [allLeads, setAllLeads] = useState<Driver[]>([]);
  const [selectedLead, setSelectedLead] = useState<Driver | null>(null);
  const [activities, setActivities] = useState<LeadActivity[]>([]);
  const [leadMessages, setLeadMessages] = useState<Message[]>([]);
  const [detailTab, setDetailTab] = useState<'chat' | 'activity' | 'review'>('chat');
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

  const [teamStaff, setTeamStaff] = useState<any[]>([]);
  const [teamLeads, setTeamLeads] = useState<any[]>([]);
  const [teamActivity, setTeamActivity] = useState<any[]>([]);
  const [closingNotes, setClosingNotes] = useState('');
  const [closingFiles, setClosingFiles] = useState<File[]>([]);
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);
  const [clockStatus, setClockStatus] = useState<{ is_clocked_in: boolean; last_clock_in_at?: string; last_clock_out_at?: string }>({ is_clocked_in: false });
  const [selectedStaffMember, setSelectedStaffMember] = useState<any | null>(null);
  const [staffLeads, setStaffLeads] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [reportStats, setReportStats] = useState<any | null>(null);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showReports, setShowReports] = useState(false);
  const [quickAssets, setQuickAssets] = useState<any[]>([]);
  const [copiedAssetId, setCopiedAssetId] = useState<string | null>(null);

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

  useEffect(() => {
    if (view === 'team' && (user.role === 'manager' || user.role === 'admin')) {
      fetchTeamData();
    }
  }, [view, user.role]);

  useEffect(() => {
    fetchClockStatus();
    fetchNotifications();
    fetchQuickAssets();
  }, []);

  const fetchNotifications = async () => {
    try {
      const data = await liveApiService.getNotifications();
      setNotifications(data);
    } catch (err) {
      console.error('Failed to fetch notifications', err);
    }
  };

  const fetchReportStats = async () => {
    try {
      setLoading(true);
      const data = await liveApiService.getReportStats();
      setReportStats(data);
    } catch (err) {
      console.error('Failed to fetch report stats', err);
    } finally {
      setLoading(false);
    }
  };

  const handleMarkNotificationRead = async (id: string) => {
    try {
      await liveApiService.markNotificationRead(id);
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
    } catch (err) {
      console.error('Failed to mark notification as read', err);
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await liveApiService.markAllNotificationsRead();
      setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
    } catch (err) {
      console.error('Failed to mark all notifications as read', err);
    }
  };

  const fetchClockStatus = async () => {
    try {
      const status = await liveApiService.getClockStatus();
      setClockStatus(status);
    } catch (err) {
      console.error('Failed to fetch clock status', err);
    }
  };

  const fetchQuickAssets = async () => {
    try {
      const data = await liveApiService.getMediaLibrary('/Quick Assets');
      if (data && data.files) {
        setQuickAssets(data.files.slice(0, 4));
      }
    } catch (err) {
      console.error('Failed to fetch quick assets:', err);
    }
  };

  const handleCopyAssetLink = (url: string, id: string) => {
    navigator.clipboard.writeText(url);
    setCopiedAssetId(id);
    setTimeout(() => setCopiedAssetId(null), 2000);
  };

  const handleClockIn = async () => {
    try {
      setLoading(true);
      await liveApiService.clockIn();
      await fetchClockStatus();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleClockOut = async () => {
    try {
      setLoading(true);
      await liveApiService.clockOut();
      await fetchClockStatus();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchTeamData = async () => {
    try {
      setLoading(true);
      const [staff, leads, activity] = await Promise.all([
        liveApiService.getTeamStaff(),
        liveApiService.getTeamLeads(),
        liveApiService.getTeamActivity()
      ]);
      setTeamStaff(staff);
      setTeamLeads(leads);
      setTeamActivity(activity);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch team data');
    } finally {
      setLoading(false);
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

  const handleViewStaffLeads = (staff: any) => {
    setSelectedStaffMember(staff);
    const leads = teamLeads.filter(l => l.assigned_to === staff.id);
    setStaffLeads(leads);
  };

  const handleTakeover = async () => {
    if (!selectedLead) return;
    try {
      setLoading(true);
      await liveApiService.updateLeadAssignment(selectedLead.id, user.staffId!);
      const updatedLead = { ...selectedLead, assigned_to: user.staffId };
      setSelectedLead(updatedLead);
      // Refresh leads list
      if (view === 'team') {
        await fetchTeamData();
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLogAction = async (action: string) => {
    if (!selectedLead) return;
    try {
      setLoading(true);
      await liveApiService.logLeadAction(selectedLead.id, {
        action,
        notes: actionNote,
        status: actionStatus || undefined
      });
      setActionNote('');
      setActionStatus('');
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

  const handleSubmitReview = async () => {
    if (!selectedLead || !closingNotes.trim()) return;
    setIsSubmittingReview(true);
    try {
      const attachmentUrls: string[] = [];
      for (const file of closingFiles) {
        const upload = await liveApiService.uploadMedia(file, `reviews/${selectedLead.id}`);
        attachmentUrls.push(upload.url);
      }
      
      await liveApiService.submitLeadReview(selectedLead.id, {
        notes: closingNotes,
        attachments: attachmentUrls
      });
      
      const updatedLeads = await liveApiService.getMyLeads();
      setAllLeads(updatedLeads);
      const updatedLead = updatedLeads.find(l => l.id === selectedLead.id);
      if (updatedLead) setSelectedLead(updatedLead);
      
      setClosingNotes('');
      setClosingFiles([]);
      setDetailTab('activity');
    } catch (err: any) {
      setError(err.message || 'Failed to submit review');
    } finally {
      setIsSubmittingReview(false);
    }
  };

  const handleApproveReview = async () => {
    if (!selectedLead) return;
    setLoading(true);
    try {
      await liveApiService.approveLeadReview(selectedLead.id);
      const updatedLeads = await liveApiService.getMyLeads();
      setAllLeads(updatedLeads);
      const updatedLead = updatedLeads.find(l => l.id === selectedLead.id);
      if (updatedLead) setSelectedLead(updatedLead);
    } catch (err: any) {
      setError(err.message || 'Failed to approve review');
    } finally {
      setLoading(false);
    }
  };

  const handleRejectReview = async () => {
    if (!selectedLead) return;
    setLoading(true);
    try {
      await liveApiService.rejectLeadReview(selectedLead.id);
      const updatedLeads = await liveApiService.getMyLeads();
      setAllLeads(updatedLeads);
      const updatedLead = updatedLeads.find(l => l.id === selectedLead.id);
      if (updatedLead) setSelectedLead(updatedLead);
    } catch (err: any) {
      setError(err.message || 'Failed to reject review');
    } finally {
      setLoading(false);
    }
  };

  const renderTeam = () => {
    if (selectedStaffMember) {
      return (
        <div className="flex flex-col h-full animate-in slide-in-from-right duration-300">
          <div className="p-4 bg-white border-b border-gray-100 sticky top-0 z-10">
            <div className="flex items-center gap-3 mb-4">
              <button onClick={() => setSelectedStaffMember(null)} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
                <ArrowLeft size={20} />
              </button>
              <div>
                <h2 className="text-lg font-bold">{selectedStaffMember.name}'s Leads</h2>
                <p className="text-[10px] text-gray-400 uppercase font-bold tracking-widest">Team Member Monitoring</p>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {staffLeads.length === 0 ? (
              <div className="text-center py-20">
                <div className="bg-gray-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Users size={32} className="text-gray-300" />
                </div>
                <p className="text-gray-500 font-medium">No leads assigned to this staff member</p>
              </div>
            ) : (
              staffLeads.map(lead => (
                <div 
                  key={lead.id} 
                  onClick={() => handleOpenDetail(lead)}
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
                  <div className="flex items-center justify-between mt-4 text-[10px] text-gray-400 font-bold uppercase tracking-widest">
                    <span>Last Action: {lead.last_action_at ? new Date(lead.last_action_at).toLocaleDateString() : 'Never'}</span>
                    <ChevronRight size={14} />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="p-4 space-y-6 animate-in fade-in duration-300">
        <div className="bg-gradient-to-br from-indigo-600 to-blue-700 text-white p-6 rounded-3xl shadow-xl">
          <h2 className="text-xl font-bold">Team Performance</h2>
          <p className="text-indigo-100 text-xs mt-1">Monitoring {teamStaff.length} staff members</p>
          
          <div className="mt-6 grid grid-cols-3 gap-2">
            <div className="bg-white/10 p-3 rounded-2xl border border-white/10 text-center">
              <p className="text-[8px] font-bold text-indigo-200 uppercase">Total Leads</p>
              <p className="text-lg font-bold">{teamLeads.length}</p>
            </div>
            <div className="bg-white/10 p-3 rounded-2xl border border-white/10 text-center">
              <p className="text-[8px] font-bold text-indigo-200 uppercase">Pending Review</p>
              <p className="text-lg font-bold">{teamLeads.filter(l => l.review_status === 'pending').length}</p>
            </div>
            <div className="bg-white/10 p-3 rounded-2xl border border-white/10 text-center">
              <p className="text-[8px] font-bold text-indigo-200 uppercase">Active Staff</p>
              <p className="text-lg font-bold">
                {teamStaff.filter(s => {
                  const lastActive = s.last_active_at ? new Date(s.last_active_at).getTime() : 0;
                  return Date.now() - lastActive < 5 * 60 * 1000;
                }).length}
              </p>
            </div>
          </div>
        </div>

        {/* Team Members */}
        <div className="space-y-4">
          <h3 className="text-sm font-bold text-gray-900 uppercase tracking-widest flex items-center gap-2">
            <Users size={16} className="text-blue-600" />
            Team Members
          </h3>
          <div className="grid grid-cols-1 gap-3">
            {teamStaff.map(member => (
              <div 
                key={member.id} 
                onClick={() => handleViewStaffLeads(member)}
                className="bg-white p-4 rounded-3xl border border-gray-100 shadow-sm flex items-center justify-between cursor-pointer hover:bg-gray-50 transition-all"
              >
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <div className="w-10 h-10 rounded-2xl bg-gray-100 flex items-center justify-center font-bold text-gray-600">
                      {member.name.charAt(0)}
                    </div>
                    <div className={`absolute -bottom-1 -right-1 w-3 h-3 rounded-full border-2 border-white ${
                      member.is_clocked_in ? 'bg-green-500' : 'bg-gray-300'
                    }`} />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-gray-900">{member.name}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <p className="text-[10px] text-gray-400">
                        {member.is_clocked_in 
                          ? `Clocked in at ${new Date(member.last_clock_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` 
                          : member.last_clock_out_at 
                            ? `Clocked out ${new Date(member.last_clock_out_at).toLocaleDateString()}`
                            : 'Never clocked in'}
                      </p>
                      {member.last_active_at && (
                        <div className="flex items-center gap-1">
                          <div className={`w-1 h-1 rounded-full ${
                            Date.now() - new Date(member.last_active_at).getTime() < 5 * 60 * 1000 ? 'bg-green-500' : 'bg-gray-300'
                          }`} />
                          <p className="text-[9px] text-gray-400">
                            {Date.now() - new Date(member.last_active_at).getTime() < 60 * 1000 ? 'Just now' : `${Math.floor((Date.now() - new Date(member.last_active_at).getTime()) / 60000)}m ago`}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex gap-2">
                    <div className="text-center px-2 py-1 bg-blue-50 rounded-lg border border-blue-100">
                      <p className="text-[8px] font-bold text-blue-600 uppercase">Leads</p>
                      <p className="text-xs font-bold text-blue-700">{member.leads_claimed_today || 0}</p>
                    </div>
                    <div className="text-center px-2 py-1 bg-emerald-50 rounded-lg border border-emerald-100">
                      <p className="text-[8px] font-bold text-emerald-600 uppercase">Acts</p>
                      <p className="text-xs font-bold text-emerald-700">{member.interactions_today || 0}</p>
                    </div>
                    <div className="text-center px-2 py-1 bg-purple-50 rounded-lg border border-purple-100">
                      <p className="text-[8px] font-bold text-purple-600 uppercase">Closes</p>
                      <p className="text-xs font-bold text-purple-700">{member.closings_today || 0}</p>
                    </div>
                  </div>
                  <div className="text-right min-w-[60px]">
                    <p className="text-xs font-bold text-gray-900">{teamLeads.filter(l => l.assigned_to === member.id).length} Total</p>
                    <p className="text-[10px] text-gray-400">Assigned</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Pending Reviews */}
        <div className="space-y-4">
          <h3 className="text-sm font-bold text-gray-900 uppercase tracking-widest flex items-center gap-2">
            <AlertCircle size={16} className="text-amber-500" />
            Pending Reviews
          </h3>
          <div className="bg-white rounded-3xl border border-gray-100 shadow-sm overflow-hidden divide-y divide-gray-50">
            {teamLeads.filter(l => l.review_status === 'pending').length === 0 ? (
              <div className="p-8 text-center">
                <p className="text-sm text-gray-400">No leads pending review</p>
              </div>
            ) : (
              teamLeads.filter(l => l.review_status === 'pending').map(lead => (
                <div 
                  key={lead.id} 
                  className="p-4 hover:bg-gray-50 transition-colors cursor-pointer group flex items-center justify-between"
                  onClick={() => {
                    setSelectedLead(lead);
                    setView('detail');
                  }}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center font-bold">
                      {lead.name.charAt(0)}
                    </div>
                    <div>
                      <p className="text-sm font-bold text-gray-900 group-hover:text-blue-600 transition-colors">{lead.name}</p>
                      <p className="text-[10px] text-gray-500">
                        Assigned to: {teamStaff.find(s => s.id === lead.assigned_to)?.name || 'Unknown'}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] text-gray-400 mb-1">
                      {new Date(lead.last_action_at || lead.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                    <button className="text-[10px] font-bold text-blue-600 uppercase tracking-wider bg-blue-50 px-2 py-1 rounded-lg">
                      Review
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recent Team Activity */}
        <div className="space-y-4">
          <h3 className="text-sm font-bold text-gray-900 uppercase tracking-widest flex items-center gap-2">
            <History size={16} className="text-blue-600" />
            Recent Activity
          </h3>
          <div className="space-y-3">
            {teamActivity.slice(0, 10).map(act => (
              <div key={act.id} className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm">
                <div className="flex justify-between items-start mb-1">
                  <p className="text-[10px] font-bold text-blue-600 uppercase tracking-wider">{act.staff_name}</p>
                  <p className="text-[8px] text-gray-400">{new Date(act.created_at).toLocaleTimeString()}</p>
                </div>
                <p className="text-xs font-bold text-gray-900 mb-1">{act.action}</p>
                <p className="text-[10px] text-gray-500 line-clamp-2">{act.notes}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
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
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold">{user.name.split(' ')[0]}</h2>
            <div className="flex items-center gap-2">
              {clockStatus.is_clocked_in ? (
                <button 
                  onClick={handleClockOut}
                  className="bg-red-500/20 text-red-400 px-3 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-widest border border-red-500/30 flex items-center gap-2 active:scale-95 transition-all"
                >
                  <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                  Clock Out
                </button>
              ) : (
                <button 
                  onClick={handleClockIn}
                  className="bg-emerald-500/20 text-emerald-400 px-3 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-widest border border-emerald-500/30 flex items-center gap-2 active:scale-95 transition-all"
                >
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  Clock In
                </button>
              )}
            </div>
          </div>
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

      <div className="grid grid-cols-1 gap-4">
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

      {quickAssets.length > 0 && (
        <div className="pt-2">
          <div className="flex items-center justify-between mb-4 px-1">
            <h3 className="text-sm font-bold text-gray-900">Quick Assets</h3>
            <button onClick={() => setView('media')} className="text-[10px] font-bold text-blue-600 uppercase tracking-widest">View All</button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {quickAssets.map(asset => (
              <div key={asset.id} className="bg-white p-3 rounded-2xl border border-gray-100 flex items-center gap-3 group">
                <div className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center text-gray-400">
                  {asset.type.startsWith('image') ? <ImageIcon size={16} /> : <FileText size={16} />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-bold text-gray-900 truncate">{asset.filename}</p>
                  <button 
                    onClick={() => handleCopyAssetLink(asset.url, asset.id)}
                    className="text-[8px] font-bold text-blue-600 uppercase tracking-widest flex items-center gap-1 mt-0.5"
                  >
                    {copiedAssetId === asset.id ? <Check size={8} /> : <Copy size={8} />}
                    {copiedAssetId === asset.id ? 'Copied' : 'Copy Link'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
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
                  <button 
                    onClick={(e) => { e.stopPropagation(); handleClaim(lead.id); }}
                    className="flex-1 bg-black text-white py-3 rounded-2xl text-xs font-bold flex items-center justify-center gap-2"
                  >
                    <UserCheck size={14} /> Claim Lead
                  </button>
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
            {selectedLead.lead_score !== undefined && (
              <div className="bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full text-[10px] font-bold flex items-center gap-1">
                <Star size={10} fill="currentColor" />
                {selectedLead.lead_score} pts
              </div>
            )}
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
            {(selectedLead as any).assigned_to !== user.staffId && (user.role === 'manager' || user.role === 'admin') && (
              <button 
                onClick={handleTakeover}
                disabled={loading}
                className="bg-black text-white px-3 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-widest active:scale-95 transition-all flex items-center gap-2"
              >
                <Zap size={12} fill="currentColor" />
                Takeover
              </button>
            )}
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
                Chat
              </button>
              <button 
                onClick={() => setDetailTab('activity')}
                className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 ${
                  detailTab === 'activity' ? 'bg-white text-black shadow-sm' : 'text-gray-500'
                }`}
              >
                <History size={16} />
                Activity
              </button>
              <button 
                onClick={() => setDetailTab('review')}
                className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 ${
                  detailTab === 'review' ? 'bg-white text-black shadow-sm' : 'text-gray-500'
                }`}
              >
                <CheckCircle size={16} />
                Review
              </button>
            </div>
          </div>

          {detailTab === 'chat' && (
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
          )}

          {detailTab === 'review' && (
            <div className="p-4 space-y-6 animate-in fade-in duration-300">
              {/* Review Status Banner */}
              {selectedLead.review_status && selectedLead.review_status !== 'none' && (
                <div className={`p-4 rounded-2xl flex items-center gap-3 ${
                  selectedLead.review_status === 'pending' ? 'bg-amber-50 text-amber-700 border border-amber-100' :
                  selectedLead.review_status === 'approved' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' :
                  'bg-red-50 text-red-700 border border-red-100'
                }`}>
                  <AlertCircle size={20} />
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wider">Review Status: {selectedLead.review_status}</p>
                    {selectedLead.review_status === 'pending' && <p className="text-[10px] opacity-80">Waiting for Manager/Admin approval</p>}
                  </div>
                </div>
              )}

              {/* Submit Review Form (for Staff) */}
              {(!selectedLead.review_status || selectedLead.review_status === 'none' || selectedLead.review_status === 'rejected') && (
                <div className="bg-white p-6 rounded-3xl border border-gray-100 shadow-sm">
                  <h4 className="text-sm font-bold text-gray-900 mb-4">Submit for Closing Review</h4>
                  <div className="space-y-4">
                    <div>
                      <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2 block">Final Closing Notes</label>
                      <textarea 
                        placeholder="Add final notes for Manager and Admin..."
                        className="w-full px-4 py-3 rounded-2xl bg-gray-50 border-none text-sm focus:ring-2 focus:ring-blue-500 transition-all min-h-[120px] resize-none"
                        value={closingNotes}
                        onChange={e => setClosingNotes(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2 block">Attachments (Screenshots)</label>
                      <div className="flex items-center gap-2">
                        <label className="flex-1 flex items-center justify-center gap-2 p-4 bg-gray-50 border-2 border-dashed border-gray-200 rounded-2xl cursor-pointer hover:bg-gray-100 transition-all">
                          <Paperclip size={20} className="text-gray-400" />
                          <span className="text-xs text-gray-500 font-medium">
                            {closingFiles.length > 0 ? `${closingFiles.length} files selected` : 'Upload Screenshots'}
                          </span>
                          <input 
                            type="file" 
                            multiple 
                            className="hidden" 
                            onChange={e => e.target.files && setClosingFiles(Array.from(e.target.files))}
                          />
                        </label>
                      </div>
                    </div>
                    <button 
                      onClick={handleSubmitReview}
                      disabled={isSubmittingReview || !closingNotes.trim()}
                      className="w-full bg-blue-600 text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-2 disabled:opacity-50 active:scale-95 transition-all shadow-lg shadow-blue-100"
                    >
                      {isSubmittingReview ? <Loader2 className="animate-spin" size={20} /> : <><Send size={20} /> Submit to Manager</>}
                    </button>
                  </div>
                </div>
              )}

              {/* Manager/Admin Review Actions */}
              {selectedLead.review_status === 'pending' && (user.role === 'admin' || user.role === 'manager') && (
                <div className="bg-white p-6 rounded-3xl border border-gray-100 shadow-sm">
                  <h4 className="text-sm font-bold text-gray-900 mb-4">Review Lead Closing</h4>
                  <div className="mb-6 p-4 bg-gray-50 rounded-2xl">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Staff Notes</p>
                    <p className="text-sm text-gray-700 leading-relaxed">{selectedLead.closing_notes}</p>
                  </div>
                  
                  {selectedLead.closing_attachments && selectedLead.closing_attachments.length > 0 && (
                    <div className="mb-6">
                      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3">Attachments</p>
                      <div className="grid grid-cols-2 gap-2">
                        {selectedLead.closing_attachments.map((url, idx) => (
                          <a key={idx} href={url} target="_blank" rel="noopener noreferrer" className="block rounded-xl overflow-hidden border border-gray-100">
                            <img src={url} alt={`Attachment ${idx + 1}`} className="w-full h-24 object-cover" />
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <button 
                      onClick={handleRejectReview}
                      disabled={loading}
                      className="flex items-center justify-center gap-2 py-4 bg-red-50 text-red-600 rounded-2xl font-bold text-sm border border-red-100 active:scale-95 transition-all"
                    >
                      <X size={20} /> Reject
                    </button>
                    <button 
                      onClick={handleApproveReview}
                      disabled={loading}
                      className="flex items-center justify-center gap-2 py-4 bg-emerald-600 text-white rounded-2xl font-bold text-sm shadow-lg shadow-emerald-100 active:scale-95 transition-all"
                    >
                      <CheckCircle size={20} /> Approve
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {detailTab === 'activity' && (
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
                      <option value="">Update Status...</option>
                      <option value="followed_up">Followed Up</option>
                      <option value="interested">Interested</option>
                      <option value="not_interested">Not Interested</option>
                      <option value="booked">Booked / Closed</option>
                      <option value="no_answer">No Answer</option>
                    </select>

                    <textarea 
                      placeholder="Add a note about this interaction..."
                      className="w-full px-4 py-3 rounded-2xl bg-gray-50 border-none text-sm focus:ring-2 focus:ring-blue-500 transition-all min-h-[100px] resize-none"
                      value={actionNote}
                      onChange={e => setActionNote(e.target.value)}
                    />

                    <button 
                      onClick={() => handleLogAction('interaction')}
                      disabled={loading || !actionNote}
                      className="w-full bg-black text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-2 disabled:opacity-50 active:scale-95 transition-all"
                    >
                      {loading ? <Loader2 className="animate-spin" size={20} /> : <><CheckCircle size={20} /> Save Interaction</>}
                    </button>
                  </div>
                </div>
              </div>

              {/* Activity Timeline */}
              <div className="p-4 pb-10">
                <h4 className="text-sm font-bold text-gray-900 mb-4 px-1">Activity History</h4>
                <div className="space-y-4 relative before:absolute before:left-[19px] before:top-2 before:bottom-2 before:w-0.5 before:bg-gray-200">
                  {activities.map((activity, idx) => (
                    <div key={activity.id} className="relative pl-10">
                      <div className="absolute left-0 top-1 w-10 h-10 rounded-full bg-white border-2 border-gray-200 flex items-center justify-center z-10">
                        <div className="w-2 h-2 rounded-full bg-blue-600" />
                      </div>
                      <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm">
                        <div className="flex justify-between items-start mb-1">
                          <p className="text-xs font-bold text-gray-900 uppercase tracking-wider">{activity.action}</p>
                          <p className="text-[10px] text-gray-400">{new Date(activity.created_at).toLocaleString()}</p>
                        </div>
                        <p className="text-sm text-gray-600 leading-relaxed">{activity.notes}</p>
                        <p className="text-[10px] text-gray-400 mt-2 font-medium italic">Logged by {activity.staff_name}</p>
                      </div>
                    </div>
                  ))}
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

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans max-w-md mx-auto border-x border-gray-200 shadow-2xl">
      {/* Top Bar */}
      {view !== 'detail' && (
        <header className="bg-white px-6 py-4 border-b border-gray-100 flex items-center justify-between sticky top-0 z-20">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-black text-white flex items-center justify-center font-bold">
              E
            </div>
            <div>
              <h1 className="text-sm font-bold text-gray-900">Encho Staff</h1>
              <p className="text-[10px] text-emerald-600 font-bold uppercase tracking-widest flex items-center gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Online
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button 
              onClick={() => {
                setShowNotifications(!showNotifications);
                setShowReports(false);
              }}
              className="p-2 text-gray-400 hover:text-blue-600 transition-colors relative"
            >
              <Bell size={20} />
              {notifications.some(n => !n.is_read) && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full border-2 border-white" />
              )}
            </button>
            {(user.role === 'manager' || user.role === 'admin') && (
              <button 
                onClick={() => {
                  setShowReports(!showReports);
                  setShowNotifications(false);
                  if (!showReports) fetchReportStats();
                }}
                className="p-2 text-gray-400 hover:text-blue-600 transition-colors"
              >
                <BarChart3 size={20} />
              </button>
            )}
            <button onClick={onLogout} className="p-2 text-gray-400 hover:text-red-600 transition-colors">
              <LogOut size={20} />
            </button>
          </div>
        </header>
      )}

      {/* Content Area */}
      <main className="flex-1 overflow-hidden relative">
        {showNotifications && (
          <div className="absolute inset-0 z-50 bg-white animate-in slide-in-from-top duration-300 flex flex-col">
            <div className="p-4 border-b flex items-center justify-between">
              <h3 className="font-bold">Notifications</h3>
              <div className="flex items-center gap-2">
                <button onClick={handleMarkAllRead} className="text-[10px] font-bold text-blue-600 uppercase tracking-widest">Mark all read</button>
                <button onClick={() => setShowNotifications(false)} className="p-1 hover:bg-gray-100 rounded-full"><X size={20} /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {notifications.length === 0 ? (
                <div className="text-center py-20 text-gray-400">No notifications</div>
              ) : (
                notifications.map(n => (
                  <div 
                    key={n.id} 
                    onClick={() => handleMarkNotificationRead(n.id)}
                    className={`p-4 rounded-2xl border transition-all ${n.is_read ? 'bg-white border-gray-100 opacity-60' : 'bg-blue-50 border-blue-100 shadow-sm'}`}
                  >
                    <div className="flex justify-between items-start mb-1">
                      <p className="text-xs font-bold text-gray-900">{n.title}</p>
                      <p className="text-[8px] text-gray-400">{new Date(n.created_at).toLocaleString()}</p>
                    </div>
                    <p className="text-xs text-gray-600">{n.message}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {showReports && (
          <div className="absolute inset-0 z-50 bg-white animate-in slide-in-from-top duration-300 flex flex-col">
            <div className="p-4 border-b flex items-center justify-between">
              <h3 className="font-bold">Performance Analytics</h3>
              <button onClick={() => setShowReports(false)} className="p-1 hover:bg-gray-100 rounded-full"><X size={20} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-8">
              {loading ? (
                <div className="flex items-center justify-center py-20"><Loader2 className="animate-spin text-blue-600" /></div>
              ) : reportStats ? (
                <>
                  {/* Daily Conversions Chart */}
                  <div className="space-y-4">
                    <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">7-Day Conversion Trend</h4>
                    <div className="h-64 w-full bg-white rounded-3xl border border-gray-100 p-4 shadow-sm">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={reportStats.conversions}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                          <XAxis 
                            dataKey="date" 
                            tickFormatter={(str) => new Date(str).toLocaleDateString([], { weekday: 'short' })}
                            axisLine={false}
                            tickLine={false}
                            tick={{ fontSize: 10, fontWeight: 600, fill: '#9ca3af' }}
                          />
                          <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 600, fill: '#9ca3af' }} />
                          <Tooltip 
                            contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                            labelFormatter={(str) => new Date(str).toLocaleDateString()}
                          />
                          <Bar dataKey="count" fill="#2563eb" radius={[6, 6, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  {/* Lead Sources Pie */}
                  <div className="grid grid-cols-1 gap-6">
                    <div className="space-y-4">
                      <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Lead Source Distribution</h4>
                      <div className="h-64 w-full bg-white rounded-3xl border border-gray-100 p-4 shadow-sm flex items-center">
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie
                              data={reportStats.sources}
                              cx="50%"
                              cy="50%"
                              innerRadius={60}
                              outerRadius={80}
                              paddingAngle={5}
                              dataKey="count"
                              nameKey="source"
                            >
                              {reportStats.sources.map((entry: any, index: number) => (
                                <Cell key={`cell-${index}`} fill={['#2563eb', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'][index % 5]} />
                              ))}
                            </Pie>
                            <Tooltip />
                          </PieChart>
                        </ResponsiveContainer>
                        <div className="w-1/3 space-y-2">
                          {reportStats.sources.map((s: any, i: number) => (
                            <div key={i} className="flex items-center gap-2">
                              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: ['#2563eb', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'][i % 5] }} />
                              <span className="text-[10px] font-bold text-gray-600 truncate">{s.source || 'Direct'}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Staff Performance */}
                  <div className="space-y-4">
                    <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Top Performers</h4>
                    <div className="space-y-3">
                      {reportStats.performance.map((s: any, i: number) => (
                        <div key={i} className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm flex items-center justify-between hover:border-blue-200 transition-colors">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-2xl bg-gray-50 flex items-center justify-center font-bold text-sm text-gray-700 border border-gray-100">
                              {s.name.charAt(0)}
                            </div>
                            <div>
                              <p className="text-sm font-bold text-gray-900">{s.name}</p>
                              <div className="flex items-center gap-2">
                                <span className="text-[9px] text-emerald-600 font-bold uppercase tracking-widest">Top Closer</span>
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-4">
                            <div className="text-right">
                              <p className="text-[10px] font-bold text-gray-900">{s.closures}</p>
                              <p className="text-[8px] text-gray-400 uppercase font-bold tracking-widest">Deals</p>
                            </div>
                            <div className="w-10 h-10 rounded-full border-4 border-emerald-100 flex items-center justify-center">
                              <span className="text-[10px] font-bold text-emerald-600">{(s.closures / (reportStats.performance.reduce((a:any,b:any)=>a+(b.closures||0),0)||1) * 100).toFixed(0)}%</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-center py-20 text-gray-400">No data available</div>
              )}
            </div>
          </div>
        )}
        {view === 'dashboard' && renderDashboard()}
        {view === 'pool' && renderLeadList(true)}
        {view === 'my-leads' && renderLeadList(false)}
        {view === 'detail' && renderDetail()}
        {view === 'team' && renderTeam()}
        {view === 'media' && <div className="h-full overflow-y-auto"><MediaLibrary /></div>}
      </main>

      {/* Bottom Navigation */}
      {view !== 'detail' && (
        <nav className="bg-white border-t border-gray-100 px-6 py-3 flex items-center justify-around sticky bottom-0 z-20 pb-8">
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
          <button 
            onClick={() => setView('media')}
            className={`flex flex-col items-center gap-1 transition-all ${view === 'media' ? 'text-blue-600' : 'text-gray-400'}`}
          >
            <Library size={20} />
            <span className="text-[10px] font-bold uppercase tracking-widest">Assets</span>
          </button>
          {(user.role === 'manager' || user.role === 'admin') && (
            <button 
              onClick={() => setView('team')}
              className={`flex flex-col items-center gap-1 transition-all ${view === 'team' ? 'text-blue-600' : 'text-gray-400'}`}
            >
              <ClipboardList size={20} />
              <span className="text-[10px] font-bold uppercase tracking-widest">Team</span>
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
    </div>
  );
};
