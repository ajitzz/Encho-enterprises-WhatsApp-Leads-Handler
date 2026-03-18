
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
  X
} from 'lucide-react';
import { liveApiService } from '../services/liveApiService.ts';
import { Driver, Message } from '../types.ts';

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [actionNote, setActionNote] = useState('');
  const [actionStatus, setActionStatus] = useState('');
  const [connectionState, setConnectionState] = useState<string>('connecting');

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
        onConnectionStateChange: (state) => setConnectionState(state)
      }
    );
    return () => unsubscribe();
  }, []);

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
    try {
      const history = await liveApiService.getLeadActivity(lead.id);
      setActivities(history);
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
                <p className="text-sm font-bold text-gray-900">{lead.name}</p>
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
                    <h4 className="font-bold text-gray-900">{lead.name}</h4>
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
              <h3 className="text-xl font-bold text-gray-900">{lead.name}</h3>
              <p className="text-gray-500 mb-6">{lead.phone_number}</p>
              
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
