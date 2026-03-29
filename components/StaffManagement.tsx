
import React, { useState, useEffect } from 'react';
import { Users, UserPlus, Trash2, Shield, Mail, Search, Loader2, AlertCircle, GitBranch, Briefcase, Activity } from 'lucide-react';
import { liveApiService } from '../services/liveApiService.ts';
import { StaffMember, UserRole } from '../types';

interface StaffManagementProps {
  onShadowUser?: (user: any) => void;
}

export const StaffManagement: React.FC<StaffManagementProps> = ({ onShadowUser }) => {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [newStaff, setNewStaff] = useState({ email: '', name: '', role: 'staff' as UserRole, manager_id: null as string | null });
  const [searchQuery, setSearchQuery] = useState('');
  const [autoDistSettings, setAutoDistSettings] = useState({ auto_enabled: false });
  const [hierarchy, setHierarchy] = useState<{ scope: string; managers: any[]; staffLoad: any[] } | null>(null);
  const [hierarchyLoading, setHierarchyLoading] = useState(true);

  useEffect(() => {
    fetchStaff();
    fetchSettings();
    fetchHierarchy();
  }, []);

  const fetchSettings = async () => {
    try {
      const settings = await liveApiService.getLeadDistributionSettings();
      setAutoDistSettings(settings);
    } catch (err) {
      console.error("Failed to fetch settings", err);
    }
  };

  const fetchStaff = async () => {
    try {
      setLoading(true);
      const data = await liveApiService.getStaff();
      setStaff(data);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch staff');
    } finally {
      setLoading(false);
    }
  };

  const fetchHierarchy = async () => {
    try {
      setHierarchyLoading(true);
      const overview = await liveApiService.getHierarchyOverview();
      setHierarchy(overview);
    } catch (err) {
      console.error('Failed to fetch hierarchy overview', err);
    } finally {
      setHierarchyLoading(false);
    }
  };

  const toggleGlobalAutoDist = async () => {
    const newVal = !autoDistSettings.auto_enabled;
    try {
      await liveApiService.updateLeadDistributionSettings({ auto_enabled: newVal });
      setAutoDistSettings({ auto_enabled: newVal });
    } catch (err) {
      alert("Failed to update global setting");
    }
  };

  const toggleStaffAutoDist = async (id: string, current: boolean) => {
    try {
      await liveApiService.updateStaffAutoDist(id, !current);
      setStaff(prev => prev.map(s => s.id === id ? { ...s, is_active_for_auto_dist: !current } : s));
    } catch (err) {
      alert("Failed to update staff setting");
    }
  };

  const handleAddStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLoading(true);
      await liveApiService.addStaff(newStaff);
      setNewStaff({ email: '', name: '', role: 'staff', manager_id: null });
      setIsAdding(false);
      await fetchStaff();
    } catch (err: any) {
      setError(err.message || 'Failed to add staff');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteStaff = async (id: string) => {
    if (!window.confirm('Are you sure you want to remove this staff member?')) return;
    try {
      setLoading(true);
      await liveApiService.deleteStaff(id);
      await fetchStaff();
    } catch (err: any) {
      setError(err.message || 'Failed to delete staff');
    } finally {
      setLoading(false);
    }
  };

  const filteredStaff = staff.filter(s => 
    s.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    s.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="p-6 max-w-6xl mx-auto font-sans">
      <div className="mb-8 bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="p-5 border-b border-gray-100 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <GitBranch className="text-indigo-600" size={18} />
              Hierarchy Command Center
            </h2>
            <p className="text-xs text-gray-500 mt-1">
              Supervise manager to staff ownership, load balancing, and conversion health.
            </p>
          </div>
          <button
            onClick={fetchHierarchy}
            className="text-xs px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-50 font-semibold"
          >
            Refresh
          </button>
        </div>

        {hierarchyLoading ? (
          <div className="p-8 text-center">
            <Loader2 size={24} className="animate-spin text-indigo-600 mx-auto mb-2" />
            <p className="text-xs text-gray-500 font-medium">Loading hierarchy insights...</p>
          </div>
        ) : hierarchy ? (
          <div className="p-5 space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="bg-indigo-50 rounded-xl p-4 border border-indigo-100">
                <p className="text-[10px] font-bold text-indigo-500 uppercase tracking-widest">Managers</p>
                <p className="text-2xl font-bold text-indigo-900">{hierarchy.managers.length}</p>
              </div>
              <div className="bg-blue-50 rounded-xl p-4 border border-blue-100">
                <p className="text-[10px] font-bold text-blue-500 uppercase tracking-widest">Staff under supervision</p>
                <p className="text-2xl font-bold text-blue-900">{hierarchy.staffLoad.length}</p>
              </div>
              <div className="bg-emerald-50 rounded-xl p-4 border border-emerald-100">
                <p className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest">Closed leads</p>
                <p className="text-2xl font-bold text-emerald-900">
                  {hierarchy.managers.reduce((sum, manager) => sum + Number(manager.closed_leads || 0), 0)}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-gray-50 rounded-xl border border-gray-100 overflow-hidden">
                <div className="p-3 border-b border-gray-100 flex items-center gap-2 text-xs font-bold text-gray-600 uppercase tracking-widest">
                  <Briefcase size={14} /> Manager Supervision
                </div>
                <div className="max-h-64 overflow-auto divide-y divide-gray-100">
                  {hierarchy.managers.map((manager) => (
                    <div key={manager.manager_id} className="p-3 text-sm flex justify-between items-center">
                      <div>
                        <div className="font-semibold text-gray-900 flex items-center gap-2">
                          {manager.manager_name || manager.manager_email}
                          <span className={`w-2 h-2 rounded-full ${manager.current_status === 'online' ? 'bg-emerald-500' : manager.current_status === 'idle' ? 'bg-amber-400' : 'bg-gray-300'}`}></span>
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          Staff: {manager.staff_count} · Total Leads: {manager.total_leads} · Review Pending: {manager.review_pending_leads}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs font-bold text-gray-700">Avg Approval Time</div>
                        <div className="text-sm font-black text-purple-600">{manager.avg_manager_approval_time_mins || 0}m</div>
                      </div>
                    </div>
                  ))}
                  {hierarchy.managers.length === 0 && (
                    <div className="p-4 text-xs text-gray-400">No manager data in scope.</div>
                  )}
                </div>
              </div>

              <div className="bg-gray-50 rounded-xl border border-gray-100 overflow-hidden">
                <div className="p-3 border-b border-gray-100 flex items-center gap-2 text-xs font-bold text-gray-600 uppercase tracking-widest">
                  <Activity size={14} /> Staff Workload
                </div>
                <div className="max-h-64 overflow-auto divide-y divide-gray-100">
                  {hierarchy.staffLoad.map((member) => (
                    <div key={member.staff_id} className="p-3 text-sm flex justify-between items-center">
                      <div>
                        <div className="font-semibold text-gray-900 flex items-center gap-2">
                          {member.staff_name}
                          <span className={`w-2 h-2 rounded-full ${member.current_status === 'online' ? 'bg-emerald-500' : member.current_status === 'idle' ? 'bg-amber-400' : 'bg-gray-300'}`}></span>
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          Manager: {member.manager_name || 'Unassigned'} · Active: {member.active_leads} · Closed: {member.closed_leads}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs font-bold text-gray-700">Avg Time to Review</div>
                        <div className="text-sm font-black text-blue-600">{member.avg_time_to_review_mins || 0}m</div>
                      </div>
                    </div>
                  ))}
                  {hierarchy.staffLoad.length === 0 && (
                    <div className="p-4 text-xs text-gray-400">No staff workload data in scope.</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-5 text-xs text-gray-500">Hierarchy insights are currently unavailable.</div>
        )}
      </div>

      {/* NEW: Global Live Telemetry Grid */}
      <div className="mb-8 bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="p-5 border-b border-gray-100 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <Activity className="text-emerald-600" size={18} />
              Global Live Telemetry
            </h2>
            <p className="text-xs text-gray-500 mt-1">
              Real-time presence and focus tracking for all staff members.
            </p>
          </div>
        </div>
        <div className="p-5">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {filteredStaff.map((s) => {
              const isOnline = s.current_status === 'online';
              const isIdle = s.current_status === 'idle';
              const activeMins = Math.floor((s.active_seconds_today || 0) / 60);
              const idleMins = Math.floor((s.idle_seconds_today || 0) / 60);

              return (
                <div key={s.id} className="bg-gray-50 border border-gray-100 rounded-2xl p-4 hover:shadow-md transition-all">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="relative">
                      <div className="w-10 h-10 rounded-full bg-white border border-gray-200 flex items-center justify-center text-gray-700 font-bold text-lg">
                        {s.name.charAt(0).toUpperCase()}
                      </div>
                      <div className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-white ${isOnline ? 'bg-emerald-500' : isIdle ? 'bg-amber-400' : 'bg-gray-300'}`}></div>
                    </div>
                    <div>
                      <h3 className="font-bold text-gray-900 text-sm truncate max-w-[120px]">{s.name}</h3>
                      <p className="text-[10px] text-gray-500 capitalize font-semibold">{s.current_status || 'Offline'}</p>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-2 text-center mb-3">
                    <div className="bg-white rounded-xl p-2 border border-gray-100">
                      <p className="text-[9px] text-gray-400 uppercase font-bold mb-0.5">Active</p>
                      <p className="font-bold text-gray-800 text-xs">{activeMins}m</p>
                    </div>
                    <div className="bg-white rounded-xl p-2 border border-gray-100">
                      <p className="text-[9px] text-gray-400 uppercase font-bold mb-0.5">Idle</p>
                      <p className="font-bold text-gray-800 text-xs">{idleMins}m</p>
                    </div>
                  </div>
                  {onShadowUser && s.role !== 'admin' && (
                    <button
                      onClick={() => onShadowUser(s)}
                      className="w-full py-1.5 bg-purple-100 text-purple-700 hover:bg-purple-200 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1"
                    >
                      <span className="animate-pulse">👁️</span> Shadow
                    </button>
                  )}
                </div>
              );
            })}
            {filteredStaff.length === 0 && (
              <div className="col-span-full p-8 text-center text-sm text-gray-500">
                No staff members found.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Users className="text-blue-600" />
            Staff Management
          </h1>
          <p className="text-gray-500 text-sm mt-1">Manage team access and lead distribution roles.</p>
        </div>
        <button
          onClick={() => setIsAdding(!isAdding)}
          className="flex items-center justify-center gap-2 bg-black text-white px-4 py-2.5 rounded-xl hover:bg-gray-900 transition-all shadow-sm font-medium"
        >
          {isAdding ? 'Cancel' : <><UserPlus size={18} /> Add New Staff</>}
        </button>
      </div>

      {/* Auto Distribution Global Toggle */}
      <div className="mb-8 bg-gradient-to-r from-blue-600 to-indigo-700 p-6 rounded-2xl shadow-lg text-white">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-white/20 rounded-xl flex items-center justify-center backdrop-blur-md">
              <Users size={24} />
            </div>
            <div>
              <h2 className="text-xl font-bold">Auto Lead Distribution (Round-Robin)</h2>
              <p className="text-blue-100 text-sm">Automatically assign incoming leads to selected staff members.</p>
            </div>
          </div>
          <div className="flex items-center gap-4 bg-white/10 p-2 rounded-xl backdrop-blur-md">
            <span className="text-sm font-bold uppercase tracking-wider ml-2">
              Status: {autoDistSettings.auto_enabled ? 'Active' : 'Disabled'}
            </span>
            <button
              onClick={toggleGlobalAutoDist}
              className={`relative inline-flex h-8 w-14 items-center rounded-full transition-colors focus:outline-none ${
                autoDistSettings.auto_enabled ? 'bg-green-400' : 'bg-gray-400'
              }`}
            >
              <span
                className={`inline-block h-6 w-6 transform rounded-full bg-white transition-transform ${
                  autoDistSettings.auto_enabled ? 'translate-x-7' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-xl flex items-center gap-3 text-red-700 animate-in fade-in slide-in-from-top-2">
          <AlertCircle size={20} />
          <p className="text-sm font-medium">{error}</p>
        </div>
      )}

      {isAdding && (
        <div className="mb-8 bg-white p-6 rounded-2xl border border-gray-200 shadow-sm animate-in fade-in zoom-in-95 duration-200">
          <h2 className="text-lg font-bold mb-4">Register New Staff Member</h2>
          <form onSubmit={handleAddStaff} className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">Full Name</label>
              <input
                type="text"
                required
                placeholder="e.g. John Doe"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                value={newStaff.name}
                onChange={e => setNewStaff({ ...newStaff, name: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">Gmail Address</label>
              <input
                type="email"
                required
                placeholder="e.g. john@gmail.com"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                value={newStaff.email}
                onChange={e => setNewStaff({ ...newStaff, email: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">Role</label>
              <div className="flex gap-2">
                <select
                  className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all bg-white"
                  value={newStaff.role}
                  onChange={e => setNewStaff({ ...newStaff, role: e.target.value as UserRole })}
                >
                  <option value="staff">Staff (Lead Manager)</option>
                  <option value="manager">Manager (Team Supervisor)</option>
                  <option value="admin">Admin (Full Access)</option>
                </select>
                {newStaff.role === 'staff' && (
                  <select
                    className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all bg-white"
                    value={newStaff.manager_id || ''}
                    onChange={e => setNewStaff({ ...newStaff, manager_id: e.target.value || null })}
                  >
                    <option value="">No Manager</option>
                    {staff.filter(s => s.role === 'manager').map(m => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                )}
                <button
                  type="submit"
                  disabled={loading}
                  className="bg-blue-600 text-white px-6 py-2.5 rounded-xl hover:bg-blue-700 transition-all font-bold disabled:opacity-50 flex items-center gap-2"
                >
                  {loading ? <Loader2 size={18} className="animate-spin" /> : 'Save'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="p-4 border-b border-gray-100 bg-gray-50/50 flex items-center gap-3">
          <Search size={18} className="text-gray-400" />
          <input
            type="text"
            placeholder="Search staff by name or email..."
            className="bg-transparent border-none outline-none text-sm w-full"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-gray-50/50">
                <th className="px-6 py-4 text-[10px] font-bold text-gray-500 uppercase tracking-wider">Staff Member</th>
                <th className="px-6 py-4 text-[10px] font-bold text-gray-500 uppercase tracking-wider">Role</th>
                <th className="px-6 py-4 text-[10px] font-bold text-gray-500 uppercase tracking-wider text-center">Auto-Dist</th>
                <th className="px-6 py-4 text-[10px] font-bold text-gray-500 uppercase tracking-wider">Last Assigned</th>
                <th className="px-6 py-4 text-[10px] font-bold text-gray-500 uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && staff.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center">
                    <Loader2 size={32} className="animate-spin text-blue-600 mx-auto mb-2" />
                    <p className="text-sm text-gray-500">Loading staff list...</p>
                  </td>
                </tr>
              ) : filteredStaff.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center">
                    <div className="bg-gray-100 w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3">
                      <Users size={24} className="text-gray-400" />
                    </div>
                    <p className="text-gray-500 font-medium">No staff members found</p>
                  </td>
                </tr>
              ) : (
                filteredStaff.map(s => (
                  <tr key={s.id} className="hover:bg-gray-50 transition-colors group">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-sm">
                          {s.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="font-bold text-gray-900">{s.name}</p>
                          <p className="text-xs text-gray-500 flex items-center gap-1">
                            <Mail size={12} /> {s.email}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                        s.role === 'admin' ? 'bg-purple-100 text-purple-700' : 
                        s.role === 'manager' ? 'bg-emerald-100 text-emerald-700' :
                        'bg-blue-100 text-blue-700'
                      }`}>
                        <Shield size={10} />
                        {s.role}
                      </span>
                      {s.role === 'staff' && s.manager_id && (
                        <p className="text-[9px] text-gray-400 mt-1 italic">
                          Managed by: {staff.find(m => m.id === s.manager_id)?.name || 'Unknown'}
                        </p>
                      )}
                    </td>
                    <td className="px-6 py-4 text-center">
                      <button
                        onClick={() => toggleStaffAutoDist(s.id, s.is_active_for_auto_dist)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                          s.is_active_for_auto_dist ? 'bg-blue-600' : 'bg-gray-200'
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            s.is_active_for_auto_dist ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500">
                      {s.last_assigned_at ? (
                        <span className="flex flex-col">
                          <span>{new Date(s.last_assigned_at).toLocaleDateString()}</span>
                          <span className="text-[10px] opacity-70">{new Date(s.last_assigned_at).toLocaleTimeString()}</span>
                        </span>
                      ) : (
                        <span className="text-gray-300 italic">Never</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right flex justify-end gap-2">
                      {onShadowUser && s.role !== 'admin' && (
                        <button
                          onClick={() => onShadowUser(s)}
                          className="p-2 text-purple-600 hover:text-purple-800 hover:bg-purple-100 rounded-lg transition-all opacity-0 group-hover:opacity-100 flex items-center gap-1 text-xs font-bold"
                          title="Shadow Workspace"
                        >
                          <span className="animate-pulse">👁️</span> Shadow
                        </button>
                      )}
                      {s.email !== 'ajithsabzz@gmail.com' && (
                        <button
                          onClick={() => handleDeleteStaff(s.id)}
                          className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                          title="Remove Staff"
                        >
                          <Trash2 size={18} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
