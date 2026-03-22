
import React, { useState, useEffect, useMemo } from 'react';
import { 
  Users, 
  MessageSquare, 
  TrendingUp, 
  AlertCircle, 
  Clock, 
  CheckCircle2, 
  ChevronRight, 
  Filter, 
  Search, 
  MoreVertical, 
  UserPlus, 
  ArrowRightLeft, 
  ShieldAlert,
  BarChart3,
  Activity,
  Zap,
  Phone,
  Mail,
  Calendar,
  MessageCircle,
  LayoutDashboard,
  Inbox,
  ClipboardList,
  Settings,
  LogOut,
  Menu,
  X,
  RefreshCw,
  Eye,
  MessageSquarePlus
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Driver, LeadStatus, StaffMember, Message, LeadActivityLog } from '../types';
import { liveApiService } from '../services/liveApiService';
import { formatDistanceToNow } from 'date-fns';

interface ManagerPortalProps {
  user: StaffMember;
  onLogout: () => void;
}

export const ManagerPortal: React.FC<ManagerPortalProps> = ({ user, onLogout }) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'team' | 'leads' | 'reviews'>('overview');
  const [leads, setLeads] = useState<Driver[]>([]);
  const [teamStaff, setTeamStaff] = useState<StaffMember[]>([]);
  const [commandCenter, setCommandCenter] = useState<any>(null);
  const [pendingReviews, setPendingReviews] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedLead, setSelectedLead] = useState<Driver | null>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<LeadStatus | 'All'>('All');

  // Real-time updates
  useEffect(() => {
    const unsubscribe = liveApiService.subscribeToUpdates((updatedLeads) => {
      setLeads(updatedLeads);
    });

    const fetchData = async () => {
      try {
        setIsLoading(true);
        const [staff, stats, reviews] = await Promise.all([
          liveApiService.getStaff(),
          liveApiService.getCommandCenter(user.id),
          liveApiService.getPendingReviews(user.id)
        ]);
        setTeamStaff(staff.filter(s => s.manager_id === user.id || s.id === user.id));
        setCommandCenter(stats);
        setPendingReviews(reviews);
      } catch (error) {
        console.error('Failed to fetch manager data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 30000); // Refresh stats every 30s

    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [user.id]);

  const filteredLeads = useMemo(() => {
    return leads.filter(lead => {
      const matchesSearch = lead.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                           lead.phoneNumber.includes(searchQuery);
      const matchesStatus = filterStatus === 'All' || lead.status === filterStatus;
      return matchesSearch && matchesStatus;
    });
  }, [leads, searchQuery, filterStatus]);

  const stats = useMemo(() => {
    if (!commandCenter) return { active: 0, closed: 0, velocity: '0h' };
    const active = leads.filter(l => l.status !== LeadStatus.ONBOARDED && l.status !== LeadStatus.REJECTED).length;
    const closed = leads.filter(l => l.status === LeadStatus.ONBOARDED).length;
    const velocityHours = Math.round(commandCenter.avgSecondsToClose / 3600);
    return { active, closed, velocity: `${velocityHours}h` };
  }, [leads, commandCenter]);

  const handleReassign = async (leadId: string, staffId: string) => {
    try {
      await liveApiService.reassignLead(leadId, staffId);
      // Update local state or wait for push
    } catch (error) {
      console.error('Reassignment failed:', error);
    }
  };

  const SidebarItem = ({ id, icon: Icon, label, count }: { id: any, icon: any, label: string, count?: number }) => (
    <button
      onClick={() => {
        setActiveTab(id);
        setIsMobileMenuOpen(false);
      }}
      className={`w-full flex items-center justify-between px-4 py-3 rounded-xl transition-all duration-200 ${
        activeTab === id 
          ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200' 
          : 'text-gray-600 hover:bg-indigo-50 hover:text-indigo-600'
      }`}
    >
      <div className="flex items-center gap-3">
        <Icon className="w-5 h-5" />
        <span className="font-medium">{label}</span>
      </div>
      {count !== undefined && count > 0 && (
        <span className={`text-xs px-2 py-0.5 rounded-full ${activeTab === id ? 'bg-white/20' : 'bg-indigo-100 text-indigo-600'}`}>
          {count}
        </span>
      )}
    </button>
  );

  if (isLoading && !commandCenter) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="flex flex-col items-center gap-4">
          <RefreshCw className="w-10 h-10 text-indigo-600 animate-spin" />
          <p className="text-gray-500 font-medium">Initializing Command Center...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden font-sans">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex flex-col w-72 bg-white border-r border-gray-100 p-6">
        <div className="flex items-center gap-3 mb-10 px-2">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-200">
            <ShieldAlert className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="font-bold text-gray-900 leading-tight">Manager Portal</h1>
            <p className="text-xs text-gray-500 font-medium uppercase tracking-wider">Supervised Workspace</p>
          </div>
        </div>

        <nav className="flex-1 space-y-2">
          <SidebarItem id="overview" icon={LayoutDashboard} label="Command Center" />
          <SidebarItem id="team" icon={Users} label="Team Supervision" count={teamStaff.length} />
          <SidebarItem id="leads" icon={Inbox} label="Lead Pipeline" count={leads.length} />
          <SidebarItem id="reviews" icon={ClipboardList} label="Pending Reviews" count={pendingReviews.length} />
        </nav>

        <div className="mt-auto pt-6 border-t border-gray-100">
          <div className="flex items-center gap-3 px-2 mb-6">
            <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold">
              {user.name.charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-gray-900 truncate">{user.name}</p>
              <p className="text-xs text-gray-500 truncate">{user.email}</p>
            </div>
          </div>
          <button 
            onClick={onLogout}
            className="w-full flex items-center gap-3 px-4 py-3 text-red-600 hover:bg-red-50 rounded-xl transition-colors font-medium"
          >
            <LogOut className="w-5 h-5" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {/* Mobile Header */}
        <header className="lg:hidden flex items-center justify-between p-4 bg-white border-bottom border-gray-100 z-20">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center">
              <ShieldAlert className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-gray-900">Manager</span>
          </div>
          <button 
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg"
          >
            {isMobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </header>

        {/* Mobile Menu Overlay */}
        <AnimatePresence>
          {isMobileMenuOpen && (
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="lg:hidden absolute inset-0 bg-white z-10 p-6 flex flex-col"
            >
              <nav className="space-y-4 mt-12">
                <SidebarItem id="overview" icon={LayoutDashboard} label="Command Center" />
                <SidebarItem id="team" icon={Users} label="Team Supervision" count={teamStaff.length} />
                <SidebarItem id="leads" icon={Inbox} label="Lead Pipeline" count={leads.length} />
                <SidebarItem id="reviews" icon={ClipboardList} label="Pending Reviews" count={pendingReviews.length} />
              </nav>
              <div className="mt-auto pt-6 border-t border-gray-100">
                <button 
                  onClick={onLogout}
                  className="w-full flex items-center gap-3 px-4 py-3 text-red-600 font-medium"
                >
                  <LogOut className="w-5 h-5" />
                  <span>Sign Out</span>
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-4 lg:p-8">
          <div className="max-w-7xl mx-auto space-y-8">
            {/* Header Section */}
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
              <div>
                <h2 className="text-3xl font-bold text-gray-900 tracking-tight">
                  {activeTab === 'overview' && 'Command Center'}
                  {activeTab === 'team' && 'Team Supervision'}
                  {activeTab === 'leads' && 'Lead Pipeline'}
                  {activeTab === 'reviews' && 'Pending Reviews'}
                </h2>
                <p className="text-gray-500 mt-1 font-medium">
                  {activeTab === 'overview' && 'Real-time operational intelligence and performance metrics.'}
                  {activeTab === 'team' && 'Monitor staff workload, active chats, and performance.'}
                  {activeTab === 'leads' && 'Manage and reassign leads across your entire team.'}
                  {activeTab === 'reviews' && 'Approve or reject lead closing requests from staff.'}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 bg-white px-4 py-2 rounded-xl border border-gray-100 shadow-sm">
                  <Activity className="w-4 h-4 text-emerald-500" />
                  <span className="text-sm font-bold text-gray-700">System Live</span>
                </div>
                <button className="p-2 bg-white border border-gray-100 rounded-xl shadow-sm hover:bg-gray-50 transition-colors">
                  <RefreshCw className="w-5 h-5 text-gray-500" />
                </button>
              </div>
            </div>

            {/* Stats Overview Grid */}
            {activeTab === 'overview' && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <StatCard 
                  label="Active Leads" 
                  value={stats.active} 
                  trend="+12%" 
                  icon={TrendingUp} 
                  color="indigo" 
                />
                <StatCard 
                  label="Closed Leads" 
                  value={stats.closed} 
                  trend="+5%" 
                  icon={CheckCircle2} 
                  color="emerald" 
                />
                <StatCard 
                  label="Avg. Velocity" 
                  value={stats.velocity} 
                  trend="-2h" 
                  icon={Zap} 
                  color="amber" 
                />
                <StatCard 
                  label="SLA Breaches" 
                  value={commandCenter?.slaBreaches || 0} 
                  trend="0" 
                  icon={AlertCircle} 
                  color="red" 
                />
              </div>
            )}

            {/* Tab Content */}
            <div className="bg-white rounded-3xl border border-gray-100 shadow-sm overflow-hidden">
              {activeTab === 'overview' && (
                <div className="p-6 lg:p-8 space-y-8">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    {/* Team Performance List */}
                    <div className="space-y-6">
                      <div className="flex items-center justify-between">
                        <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                          <Users className="w-5 h-5 text-indigo-600" />
                          Staff Performance
                        </h3>
                        <button className="text-sm font-bold text-indigo-600 hover:underline">View All</button>
                      </div>
                      <div className="space-y-4">
                        {commandCenter?.teamStats?.map((staff: any) => (
                          <div key={staff.id} className="flex items-center gap-4 p-4 rounded-2xl bg-gray-50 border border-gray-100 hover:border-indigo-200 transition-all group">
                            <div className="w-12 h-12 rounded-xl bg-white flex items-center justify-center text-indigo-600 font-bold shadow-sm group-hover:bg-indigo-600 group-hover:text-white transition-colors">
                              {staff.name.charAt(0)}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between mb-1">
                                <p className="font-bold text-gray-900 truncate">{staff.name}</p>
                                <span className="text-xs font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">
                                  {staff.closed_leads} Closed
                                </span>
                              </div>
                              <div className="w-full bg-gray-200 rounded-full h-1.5">
                                <div 
                                  className="bg-indigo-600 h-1.5 rounded-full transition-all duration-500" 
                                  style={{ width: `${(staff.active_leads / staff.max_capacity) * 100}%` }}
                                />
                              </div>
                              <div className="flex items-center justify-between mt-1">
                                <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Capacity: {staff.active_leads}/{staff.max_capacity}</p>
                                <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Avg: {Math.round(staff.avg_response_time_seconds / 60)}m</p>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Conversion Velocity Chart Placeholder */}
                    <div className="space-y-6">
                      <div className="flex items-center justify-between">
                        <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                          <BarChart3 className="w-5 h-5 text-indigo-600" />
                          Lead Velocity (Last 7 Days)
                        </h3>
                      </div>
                      <div className="h-64 bg-gray-50 rounded-2xl border border-dashed border-gray-200 flex items-end justify-between p-6 gap-2">
                        {commandCenter?.heatmap?.map((day: any, i: number) => (
                          <div key={i} className="flex-1 flex flex-col items-center gap-2">
                            <div 
                              className="w-full bg-indigo-200 rounded-t-lg hover:bg-indigo-600 transition-colors cursor-pointer relative group"
                              style={{ height: `${(day.lead_count / 20) * 100}%`, minHeight: '4px' }}
                            >
                              <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-[10px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                                {day.lead_count} leads
                              </div>
                            </div>
                            <span className="text-[10px] font-bold text-gray-400 uppercase">{new Date(day.date).toLocaleDateString('en-US', { weekday: 'short' })}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'team' && (
                <div className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-gray-50 border-b border-gray-100">
                          <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider">Staff Member</th>
                          <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider">Status</th>
                          <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider">Active Leads</th>
                          <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider">Avg Response</th>
                          <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {teamStaff.map((staff) => (
                          <tr key={staff.id} className="hover:bg-gray-50 transition-colors group">
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center text-indigo-600 font-bold">
                                  {staff.name.charAt(0)}
                                </div>
                                <div>
                                  <p className="font-bold text-gray-900">{staff.name}</p>
                                  <p className="text-xs text-gray-500">{staff.email}</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-2">
                                <div className={`w-2 h-2 rounded-full ${staff.is_active_for_auto_dist ? 'bg-emerald-500 animate-pulse' : 'bg-gray-300'}`} />
                                <span className="text-sm font-medium text-gray-700">
                                  {staff.is_active_for_auto_dist ? 'Online' : 'Offline'}
                                </span>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-bold text-gray-900">
                                  {commandCenter?.teamStats?.find((s: any) => s.id === staff.id)?.active_leads || 0}
                                </span>
                                <span className="text-xs text-gray-400">/ {staff.max_capacity || 10}</span>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <span className="text-sm font-medium text-gray-700">
                                {Math.round((commandCenter?.teamStats?.find((s: any) => s.id === staff.id)?.avg_response_time_seconds || 0) / 60)}m
                              </span>
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button className="p-2 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors">
                                  <Eye className="w-5 h-5" />
                                </button>
                                <button className="p-2 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors">
                                  <MessageSquarePlus className="w-5 h-5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {activeTab === 'leads' && (
                <div className="p-6 space-y-6">
                  <div className="flex flex-col md:flex-row gap-4">
                    <div className="flex-1 relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                      <input 
                        type="text"
                        placeholder="Search leads by name or phone..."
                        className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-100 rounded-2xl focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all outline-none"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                    </div>
                    <div className="flex gap-2">
                      <select 
                        className="px-4 py-3 bg-gray-50 border border-gray-100 rounded-2xl outline-none focus:ring-2 focus:ring-indigo-500"
                        value={filterStatus}
                        onChange={(e) => setFilterStatus(e.target.value as any)}
                      >
                        <option value="All">All Status</option>
                        {Object.values(LeadStatus).map(status => (
                          <option key={status} value={status}>{status}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {filteredLeads.map((lead) => (
                      <div key={lead.id} className="p-5 rounded-2xl bg-gray-50 border border-gray-100 hover:border-indigo-200 transition-all group relative">
                        <div className="flex items-start justify-between mb-4">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center text-indigo-600 font-bold shadow-sm">
                              {lead.name.charAt(0)}
                            </div>
                            <div>
                              <h4 className="font-bold text-gray-900">{lead.name}</h4>
                              <p className="text-xs text-gray-500">{lead.phoneNumber}</p>
                            </div>
                          </div>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                            lead.status === LeadStatus.NEW ? 'bg-blue-100 text-blue-600' :
                            lead.status === LeadStatus.QUALIFIED ? 'bg-emerald-100 text-emerald-600' :
                            'bg-gray-200 text-gray-600'
                          }`}>
                            {lead.status}
                          </span>
                        </div>
                        
                        <div className="space-y-3">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-gray-500">Assigned To:</span>
                            <span className="font-bold text-gray-700">
                              {teamStaff.find(s => s.id === lead.assignedAgent)?.name || 'Unassigned'}
                            </span>
                          </div>
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-gray-500">Last Active:</span>
                            <span className="font-medium text-gray-700">{formatDistanceToNow(lead.lastMessageAt)} ago</span>
                          </div>
                        </div>

                        <div className="mt-4 pt-4 border-t border-gray-200 flex items-center justify-between gap-2">
                          <button 
                            onClick={() => setSelectedLead(lead)}
                            className="flex-1 py-2 text-xs font-bold text-indigo-600 bg-white border border-indigo-100 rounded-xl hover:bg-indigo-50 transition-colors"
                          >
                            View Details
                          </button>
                          <div className="relative group/reassign">
                            <button className="p-2 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-colors">
                              <ArrowRightLeft className="w-4 h-4" />
                            </button>
                            <div className="absolute bottom-full right-0 mb-2 w-48 bg-white rounded-xl shadow-xl border border-gray-100 p-2 hidden group-hover/reassign:block z-10">
                              <p className="text-[10px] font-bold text-gray-400 uppercase px-2 py-1 mb-1">Reassign To</p>
                              {teamStaff.map(staff => (
                                <button
                                  key={staff.id}
                                  onClick={() => handleReassign(lead.id, staff.id)}
                                  className="w-full text-left px-3 py-2 text-xs font-medium text-gray-700 hover:bg-indigo-50 hover:text-indigo-600 rounded-lg transition-colors"
                                >
                                  {staff.name}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeTab === 'reviews' && (
                <div className="p-6">
                  {pendingReviews.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-20 text-center">
                      <div className="w-16 h-16 bg-gray-50 rounded-full flex items-center justify-center mb-4">
                        <CheckCircle2 className="w-8 h-8 text-gray-300" />
                      </div>
                      <h3 className="text-lg font-bold text-gray-900">All Caught Up!</h3>
                      <p className="text-gray-500 max-w-xs mx-auto mt-2">There are no pending lead closing reviews at the moment.</p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {pendingReviews.map((review) => (
                        <div key={review.id} className="p-6 rounded-2xl bg-gray-50 border border-gray-100 flex flex-col md:flex-row gap-6">
                          <div className="flex-1 space-y-4">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <div className="w-12 h-12 rounded-xl bg-white flex items-center justify-center text-indigo-600 font-bold shadow-sm">
                                  {review.candidate_name.charAt(0)}
                                </div>
                                <div>
                                  <h4 className="font-bold text-gray-900 text-lg">{review.candidate_name}</h4>
                                  <p className="text-sm text-gray-500">Submitted by {review.staff_name} • {formatDistanceToNow(new Date(review.created_at))} ago</p>
                                </div>
                              </div>
                            </div>
                            <div className="bg-white p-4 rounded-xl border border-gray-100">
                              <p className="text-xs font-bold text-gray-400 uppercase mb-2 tracking-wider">Staff Notes</p>
                              <p className="text-gray-700 text-sm italic">"{review.notes}"</p>
                            </div>
                          </div>
                          <div className="flex md:flex-col justify-end gap-3 min-w-[160px]">
                            <button 
                              onClick={() => liveApiService.reviewDecision(review.id, { decision: 'approved' })}
                              className="flex-1 px-6 py-3 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 shadow-lg shadow-indigo-100 transition-all flex items-center justify-center gap-2"
                            >
                              <CheckCircle2 className="w-4 h-4" />
                              Approve
                            </button>
                            <button 
                              onClick={() => liveApiService.reviewDecision(review.id, { decision: 'rejected' })}
                              className="flex-1 px-6 py-3 bg-white text-red-600 border border-red-100 font-bold rounded-xl hover:bg-red-50 transition-all flex items-center justify-center gap-2"
                            >
                              <X className="w-4 h-4" />
                              Reject
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Lead Detail Modal/Drawer */}
      <AnimatePresence>
        {selectedLead && (
          <div className="fixed inset-0 z-50 flex items-center justify-end">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedLead(null)}
              className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="relative w-full max-w-2xl h-full bg-white shadow-2xl flex flex-col"
            >
              <div className="p-6 border-b border-gray-100 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <button 
                    onClick={() => setSelectedLead(null)}
                    className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                  >
                    <X className="w-6 h-6 text-gray-500" />
                  </button>
                  <div>
                    <h3 className="text-xl font-bold text-gray-900">{selectedLead.name}</h3>
                    <p className="text-sm text-gray-500">{selectedLead.phoneNumber}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button className="p-2 text-indigo-600 bg-indigo-50 rounded-xl hover:bg-indigo-100 transition-colors">
                    <Phone className="w-5 h-5" />
                  </button>
                  <button className="p-2 text-indigo-600 bg-indigo-50 rounded-xl hover:bg-indigo-100 transition-colors">
                    <Mail className="w-5 h-5" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-8">
                {/* Lead Info Grid */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 rounded-2xl bg-gray-50 border border-gray-100">
                    <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Status</p>
                    <p className="font-bold text-gray-900">{selectedLead.status}</p>
                  </div>
                  <div className="p-4 rounded-2xl bg-gray-50 border border-gray-100">
                    <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Assigned Agent</p>
                    <p className="font-bold text-gray-900">
                      {teamStaff.find(s => s.id === selectedLead.assignedAgent)?.name || 'Unassigned'}
                    </p>
                  </div>
                  <div className="p-4 rounded-2xl bg-gray-50 border border-gray-100">
                    <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Source</p>
                    <p className="font-bold text-gray-900">{selectedLead.source}</p>
                  </div>
                  <div className="p-4 rounded-2xl bg-gray-50 border border-gray-100">
                    <p className="text-[10px] font-bold text-gray-400 uppercase mb-1">Last Message</p>
                    <p className="font-bold text-gray-900">{formatDistanceToNow(selectedLead.lastMessageAt)} ago</p>
                  </div>
                </div>

                {/* Variables Section */}
                <div className="space-y-4">
                  <h4 className="font-bold text-gray-900 flex items-center gap-2">
                    <ClipboardList className="w-5 h-5 text-indigo-600" />
                    Lead Variables
                  </h4>
                  <div className="grid grid-cols-1 gap-2">
                    {Object.entries(selectedLead.variables || {}).map(([key, value]) => (
                      <div key={key} className="flex items-center justify-between p-3 rounded-xl bg-white border border-gray-100 shadow-sm">
                        <span className="text-sm text-gray-500 font-medium capitalize">{key.replace(/_/g, ' ')}</span>
                        <span className="text-sm font-bold text-gray-900">{String(value)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Activity Feed Placeholder */}
                <div className="space-y-4">
                  <h4 className="font-bold text-gray-900 flex items-center gap-2">
                    <Activity className="w-5 h-5 text-indigo-600" />
                    Recent Activity
                  </h4>
                  <div className="space-y-4 relative before:absolute before:left-4 before:top-2 before:bottom-2 before:w-0.5 before:bg-gray-100">
                    <div className="relative pl-10">
                      <div className="absolute left-2.5 top-1.5 w-3 h-3 rounded-full bg-indigo-600 border-2 border-white shadow-sm" />
                      <p className="text-sm font-bold text-gray-900">Lead Assigned</p>
                      <p className="text-xs text-gray-500">Assigned to {teamStaff.find(s => s.id === selectedLead.assignedAgent)?.name} by System</p>
                      <p className="text-[10px] text-gray-400 mt-1">2 hours ago</p>
                    </div>
                    <div className="relative pl-10">
                      <div className="absolute left-2.5 top-1.5 w-3 h-3 rounded-full bg-gray-300 border-2 border-white shadow-sm" />
                      <p className="text-sm font-bold text-gray-900">Status Changed</p>
                      <p className="text-xs text-gray-500">Changed from New to Qualified</p>
                      <p className="text-[10px] text-gray-400 mt-1">5 hours ago</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-6 border-t border-gray-100 bg-gray-50 flex flex-wrap gap-3">
                <button 
                  className="flex-1 py-3 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 shadow-lg shadow-indigo-100 transition-all flex items-center justify-center gap-2"
                >
                  <MessageCircle className="w-5 h-5" />
                  Shadow Chat
                </button>
                <button 
                  className="flex-1 py-3 bg-amber-500 text-white font-bold rounded-xl hover:bg-amber-600 shadow-lg shadow-amber-100 transition-all flex items-center justify-center gap-2"
                >
                  <Zap className="w-5 h-5" />
                  Whisper Note
                </button>
                <button 
                  className="px-6 py-3 bg-white text-gray-700 border border-gray-200 font-bold rounded-xl hover:bg-gray-50 transition-all"
                >
                  Edit Lead
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

const StatCard = ({ label, value, trend, icon: Icon, color }: any) => {
  const colors: any = {
    indigo: 'bg-indigo-50 text-indigo-600 border-indigo-100',
    emerald: 'bg-emerald-50 text-emerald-600 border-emerald-100',
    amber: 'bg-amber-50 text-amber-600 border-amber-100',
    red: 'bg-red-50 text-red-600 border-red-100'
  };

  return (
    <div className="bg-white p-6 rounded-3xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-4">
        <div className={`p-3 rounded-2xl ${colors[color]} border`}>
          <Icon className="w-6 h-6" />
        </div>
        <div className={`flex items-center gap-1 text-xs font-bold ${trend.startsWith('+') ? 'text-emerald-600' : trend.startsWith('-') ? 'text-red-600' : 'text-gray-400'}`}>
          {trend}
          <ChevronRight className="w-3 h-3" />
        </div>
      </div>
      <div>
        <p className="text-2xl font-black text-gray-900 tracking-tight">{value}</p>
        <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mt-1">{label}</p>
      </div>
    </div>
  );
};
