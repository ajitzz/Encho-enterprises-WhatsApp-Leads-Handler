
import React, { useState, useEffect } from 'react';
import { Users, UserPlus, Trash2, Shield, Mail, Search, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { liveApiService } from '../services/liveApiService.ts';

interface StaffMember {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'manager' | 'staff';
  manager_id: string | null;
  is_active_for_auto_dist: boolean;
  last_assigned_at: string | null;
  last_activity_at: string | null;
  created_at: string;
}

export const StaffManagement: React.FC = () => {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newStaff, setNewStaff] = useState({ 
    email: '', 
    name: '', 
    role: 'staff' as 'admin' | 'manager' | 'staff',
    manager_id: null as string | null
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [autoDistSettings, setAutoDistSettings] = useState({ auto_enabled: false });

  useEffect(() => {
    fetchStaff();
    fetchSettings();
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

  const handleUpdateStaff = async (id: string, updates: any) => {
    try {
      setLoading(true);
      await liveApiService.updateStaff(id, updates);
      setEditingId(null);
      await fetchStaff();
    } catch (err: any) {
      setError(err.message || 'Failed to update staff');
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
              <select
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all bg-white"
                value={newStaff.role}
                onChange={e => setNewStaff({ ...newStaff, role: e.target.value as any })}
              >
                <option value="staff">Staff (Lead Manager)</option>
                <option value="manager">Manager (Team Leader)</option>
                <option value="admin">Admin (Full Access)</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">Assign Manager</label>
              <div className="flex gap-2">
                <select
                  className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all bg-white"
                  value={newStaff.manager_id || ''}
                  onChange={e => setNewStaff({ ...newStaff, manager_id: e.target.value || null })}
                >
                  <option value="">No Manager</option>
                  {staff.filter(s => s.role === 'manager' || s.role === 'admin').map(m => (
                    <option key={m.id} value={m.id}>{m.name} ({m.role})</option>
                  ))}
                </select>
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
                <th className="px-6 py-4 text-[10px] font-bold text-gray-500 uppercase tracking-wider">Role / Manager</th>
                <th className="px-6 py-4 text-[10px] font-bold text-gray-500 uppercase tracking-wider text-center">Auto-Dist</th>
                <th className="px-6 py-4 text-[10px] font-bold text-gray-500 uppercase tracking-wider">Activity</th>
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
                      <div className="flex flex-col gap-1">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider w-fit ${
                          s.role === 'admin' ? 'bg-purple-100 text-purple-700' : 
                          s.role === 'manager' ? 'bg-indigo-100 text-indigo-700' :
                          'bg-blue-100 text-blue-700'
                        }`}>
                          <Shield size={10} />
                          {s.role}
                        </span>
                        {editingId === s.id ? (
                          <select
                            className="text-xs border rounded p-1 mt-1"
                            value={s.manager_id || ''}
                            onChange={(e) => handleUpdateStaff(s.id, { manager_id: e.target.value || null })}
                          >
                            <option value="">No Manager</option>
                            {staff.filter(m => (m.role === 'manager' || m.role === 'admin') && m.id !== s.id).map(m => (
                              <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                          </select>
                        ) : (
                          s.manager_id && (
                            <p className="text-[10px] text-gray-400 italic">
                              Reports to: {staff.find(m => m.id === s.manager_id)?.name || 'Unknown'}
                            </p>
                          )
                        )}
                      </div>
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
                      <div className="flex flex-col">
                        <span className="flex items-center gap-1">
                          <div className={`w-2 h-2 rounded-full ${
                            s.last_activity_at && (Date.now() - new Date(s.last_activity_at).getTime() < 300000) 
                              ? 'bg-green-500' : 'bg-gray-300'
                          }`} />
                          {s.last_activity_at ? (
                            <span>{new Date(s.last_activity_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          ) : 'No activity'}
                        </span>
                        {s.last_assigned_at && (
                          <span className="text-[10px] opacity-70">Last Lead: {new Date(s.last_assigned_at).toLocaleDateString()}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => setEditingId(editingId === s.id ? null : s.id)}
                          className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                          title="Edit Staff"
                        >
                          <Users size={18} />
                        </button>
                        {s.email !== 'ajithsabzz@gmail.com' && (
                          <button
                            onClick={() => handleDeleteStaff(s.id)}
                            className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                            title="Remove Staff"
                          >
                            <Trash2 size={18} />
                          </button>
                        )}
                      </div>
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
