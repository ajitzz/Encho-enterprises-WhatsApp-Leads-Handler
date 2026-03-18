
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
  Headset,
  MicOff,
  CheckCheck,
  Video,
  FileText,
  Download,
  Mic
} from 'lucide-react';
import { liveApiService } from '../services/liveApiService.ts';
import { Driver, Message } from '../types.ts';

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
  const [view, setView] = useState<'dashboard' | 'pool' | 'my-leads' | 'detail'>('dashboard');
  const [allLeads, setAllLeads] = useState<Driver[]>([]);
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
  const [botSettings, setBotSettings] = useState<any>(null);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const s = await liveApiService.getBotSettings();
        setBotSettings(s);
      } catch (e) {
        console.error("Failed to load bot settings", e);
      }
    };
    loadSettings();
  }, []);
  const [selectedMedia, setSelectedMedia] = useState<{ type: 'image' | 'video' | 'document' | 'audio'; file: File; preview: string } | null>(null);

  const isWindowActive = selectedLead ? (Date.now() - selectedLead.lastMessageTime < 24 * 60 * 60 * 1000) : false;

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const type = file.type.startsWith('image/') ? 'image' : 
                 file.type.startsWith('video/') ? 'video' : 
                 file.type.startsWith('audio/') ? 'audio' : 'document';
    
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
        documentUrl: mediaType === 'document' ? mediaUrl : undefined
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

  const handleToggleHumanMode = async () => {
    if (!selectedLead) return;
    try {
      const newMode = !selectedLead.isHumanMode;
      await liveApiService.updateDriver(selectedLead.id, { isHumanMode: newMode });
      setSelectedLead({ ...selectedLead, isHumanMode: newMode });

      // Send predefined message
      const firstName = user.name?.split(' ')[0] || 'Staff';
      let message = '';
      
      if (newMode) {
        const template = botSettings?.humanModeEntryMessage || "Hi, I am {{name}}, how may I help you?";
        message = template.replace(/\{\{name\}\}/g, firstName);
      } else {
        message = botSettings?.botModeTransitionMessage || "our Staff will get back to you shortly";
      }
      
      await liveApiService.sendMessage(selectedLead.id, message);
      
      // Refresh messages
      const messages = await liveApiService.getDriverMessages(selectedLead.id);
      setLeadMessages(messages);
    } catch (err: any) {
      setError(err.message);
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

  const formatMessageDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    
    return date.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
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
          </div>
          <button className="p-2 hover:bg-gray-100 rounded-full">
            <MoreVertical size={20} />
          </button>
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
              <div className="flex items-center gap-3 mb-6">
                <p className="text-gray-500 text-sm">{lead.phone_number}</p>
                <button 
                  onClick={handleToggleHumanMode}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold transition-all border ${lead.isHumanMode ? 'bg-emerald-500 text-white border-emerald-500' : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300'}`}
                >
                  {lead.isHumanMode ? <Headset size={12} /> : <MicOff size={12} />}
                  {lead.isHumanMode ? 'Human Mode' : 'Bot Mode'}
                </button>
              </div>

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
            <div className="flex-1 flex flex-col min-h-0 bg-[#e5ddd5]" style={{ backgroundImage: 'url("https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png")', backgroundRepeat: 'repeat', backgroundSize: '400px' }}>
              <div className="flex-1 p-4 space-y-2 overflow-y-auto custom-scrollbar">
                {leadMessages.map((msg, idx) => {
                  const isOutgoing = msg.sender !== 'driver';
                  const showTail = idx === 0 || leadMessages[idx-1].sender !== msg.sender;
                  
                  const showDateSeparator = idx === 0 || 
                    new Date(leadMessages[idx-1].timestamp).toDateString() !== new Date(msg.timestamp).toDateString();
                  
                  return (
                    <React.Fragment key={msg.id || idx}>
                      {showDateSeparator && (
                        <div className="flex justify-center my-4 sticky top-2 z-10">
                          <div className="bg-white/80 backdrop-blur-md px-4 py-1 rounded-lg shadow-sm text-[10px] font-bold text-gray-500 uppercase tracking-widest border border-white/50">
                            {formatMessageDate(msg.timestamp)}
                          </div>
                        </div>
                      )}
                      <div className={`flex ${isOutgoing ? 'justify-end' : 'justify-start'} mb-1 px-2`}>
                        <div className={`max-w-[85%] rounded-lg shadow-sm overflow-hidden relative ${isOutgoing ? 'bg-[#dcf8c6] text-gray-900' : 'bg-white text-gray-900'} ${showTail ? (isOutgoing ? 'rounded-tr-none' : 'rounded-tl-none') : ''}`}>
                          {showTail && (
                            <div className={`absolute top-0 w-2 h-2 ${isOutgoing ? '-right-1 bg-[#dcf8c6]' : '-left-1 bg-white'}`} style={{ clipPath: isOutgoing ? 'polygon(0 0, 0 100%, 100% 0)' : 'polygon(100% 0, 100% 100%, 0 0)' }}></div>
                          )}
                        {msg.type === 'image' && msg.imageUrl && (
                          <div className="w-full aspect-square bg-gray-100 rounded-t-lg overflow-hidden relative group">
                            <img src={msg.imageUrl} className="w-full h-full object-cover transition-transform group-hover:scale-105" alt="media" referrerPolicy="no-referrer" />
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-all" />
                          </div>
                        )}
                        {msg.type === 'video' && msg.videoUrl && (
                          <div className="w-full aspect-video bg-black rounded-t-lg relative group">
                            <video src={msg.videoUrl} className="w-full h-full object-contain" />
                            <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/40 transition-all">
                                <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center text-white border border-white/30">
                                    <Video size={24} />
                                </div>
                            </div>
                            <div className="absolute bottom-2 right-2 px-1.5 py-0.5 bg-black/60 rounded text-[10px] text-white font-bold flex items-center gap-1">
                                <Video size={10} /> VIDEO
                            </div>
                          </div>
                        )}
                        {msg.type === 'audio' && msg.audioUrl && (
                          <div className="w-full bg-[#f0f0f0]/50 p-3 rounded-t-lg flex items-center gap-3 border-b border-gray-100">
                              <div className="w-12 h-12 rounded-full bg-emerald-500 flex items-center justify-center text-white shadow-md flex-shrink-0">
                                  <Headset size={24} />
                              </div>
                              <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1">
                                    <div className="h-1 flex-1 bg-gray-300 rounded-full overflow-hidden">
                                      <div className="h-full bg-emerald-500 w-1/3" />
                                    </div>
                                    <span className="text-[10px] font-bold text-gray-500">0:45</span>
                                  </div>
                                  <audio src={msg.audioUrl} controls className="w-full h-8 custom-audio-player opacity-0 absolute pointer-events-none" />
                                  <div className="flex items-center justify-between">
                                    <span className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest">Voice Note</span>
                                    <Mic size={12} className="text-emerald-500" />
                                  </div>
                              </div>
                          </div>
                        )}
                        {msg.type === 'document' && msg.documentUrl && (
                          <a 
                              href={msg.documentUrl} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="w-full p-3 rounded-t-lg bg-gray-50 flex items-center gap-3 border-b border-gray-100 hover:bg-gray-100 transition-colors group"
                          >
                              <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600 group-hover:bg-blue-600 group-hover:text-white transition-all">
                                  <FileText size={20} />
                              </div>
                              <div className="flex-1 min-w-0">
                                  <p className="text-xs font-bold text-gray-900 truncate">{msg.documentUrl.split('/').pop() || 'Document'}</p>
                                  <p className="text-[10px] text-gray-400 uppercase font-bold">PDF • 1.2 MB</p>
                              </div>
                              <Download size={16} className="text-gray-400" />
                          </a>
                        )}
                        <div className="px-2 pt-1 pb-1 flex flex-col">
                            <div className="pr-12">
                                {msg.text && <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.text}</p>}
                            </div>
                            <div className="text-[9px] mt-0.5 self-end opacity-50 flex items-center gap-1">
                                {new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                                {isOutgoing && <CheckCheck size={12} className={msg.status === 'read' ? 'text-blue-500' : ''} />}
                            </div>
                        </div>
                      </div>
                    </div>
                  </React.Fragment>
                );
              })}
                {leadMessages.length === 0 && (
                  <div className="flex flex-col items-center justify-center text-center p-10 bg-white/50 backdrop-blur-sm rounded-3xl mx-4">
                    <MessageSquare size={32} className="text-gray-400 mb-2" />
                    <p className="text-sm font-bold text-gray-900">No messages yet</p>
                  </div>
                )}
              </div>

              {/* Chat Input Area */}
              <div className="p-2 bg-[#f0f0f0] border-t border-gray-200">
                {!isWindowActive ? (
                  <div className="flex flex-col items-center justify-center py-4 px-4 bg-white/80 backdrop-blur-sm rounded-xl border border-dashed border-gray-300 mx-2 my-2">
                    <History size={20} className="text-gray-400 mb-1" />
                    <h4 className="text-xs font-bold text-gray-900">Chat History Mode</h4>
                    <p className="text-[10px] text-gray-500 text-center">Window expired. Waiting for customer response.</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {selectedMedia && (
                      <div className="mx-2 p-2 bg-white rounded-lg border border-gray-200 flex items-center justify-between shadow-sm animate-in slide-in-from-bottom-2">
                        <div className="flex items-center gap-2">
                          {selectedMedia.type === 'image' ? (
                            <img src={selectedMedia.preview} className="w-8 h-8 rounded object-cover" alt="Preview" />
                          ) : (
                            <div className="w-8 h-8 bg-gray-100 rounded flex items-center justify-center text-gray-500">
                              <Paperclip size={14} />
                            </div>
                          )}
                          <span className="text-[10px] font-bold text-gray-700 truncate max-w-[150px]">{selectedMedia.file.name}</span>
                        </div>
                        <button onClick={() => setSelectedMedia(null)} className="text-gray-400 hover:text-gray-600">
                          <X size={14} />
                        </button>
                      </div>
                    )}
                    <div className="flex items-end gap-2 px-2 py-1">
                      <div className="flex-1 bg-white rounded-full flex items-center px-3 py-1 shadow-sm border border-gray-200">
                        <label className="p-2 text-gray-500 hover:text-[#075e54] cursor-pointer transition-colors">
                          <Paperclip size={20} className="rotate-45" />
                          <input type="file" className="hidden" onChange={handleFileSelect} />
                        </label>
                        <textarea 
                          placeholder="Type a message"
                          className="flex-1 bg-transparent border-none py-2 px-2 focus:outline-none text-sm min-h-[40px] max-h-[120px] resize-none"
                          value={replyText}
                          onChange={e => setReplyText(e.target.value)}
                          disabled={isSending}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              handleSendReply();
                            }
                          }}
                        />
                      </div>
                      <button 
                        onClick={handleSendReply}
                        disabled={isSending || (!replyText.trim() && !selectedMedia)}
                        className="w-12 h-12 bg-[#075e54] text-white rounded-full flex items-center justify-center disabled:opacity-50 shadow-md active:scale-95 transition-all"
                      >
                        {isSending ? <Loader2 className="animate-spin" size={20} /> : <Send size={20} />}
                      </button>
                    </div>
                  </div>
                )}
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
