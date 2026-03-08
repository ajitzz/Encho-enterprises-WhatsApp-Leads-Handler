
import React, { useState, useEffect } from 'react';
import { liveApiService } from '../services/liveApiService';
import { LmsUser } from '../types';
import { UserPlus, Trash2, Shield, Users, User } from 'lucide-react';

export const TeamManagement: React.FC = () => {
  const [users, setUsers] = useState<LmsUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newUser, setNewUser] = useState({
    email: '',
    name: '',
    role: 'staff' as 'admin' | 'manager' | 'staff',
    managerId: ''
  });

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    try {
      const data = await liveApiService.getLmsUsers();
      setUsers(data);
    } catch (e) {
      console.error("Failed to load users", e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await liveApiService.createLmsUser({
        ...newUser,
        manager_id: newUser.role === 'staff' ? newUser.managerId : null
      });
      setShowAddModal(false);
      setNewUser({ email: '', name: '', role: 'staff', managerId: '' });
      loadUsers();
    } catch (e) {
      alert("Failed to add user");
    }
  };

  const handleDeleteUser = async (id: string) => {
    if (!confirm("Are you sure you want to remove this team member?")) return;
    try {
      await liveApiService.deleteLmsUser(id);
      loadUsers();
    } catch (e) {
      alert("Failed to delete user");
    }
  };

  const managers = users.filter(u => u.role === 'manager');

  if (isLoading) return <div className="p-8 text-center text-gray-500">Loading team...</div>;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Team Management</h2>
          <p className="text-gray-500">Manage your managers and telecalling staff.</p>
        </div>
        <button 
          onClick={() => setShowAddModal(true)}
          className="bg-black text-white px-4 py-2 rounded-lg flex items-center gap-2 hover:bg-gray-800 transition-all shadow-md"
        >
          <UserPlus size={20} />
          Add Team Member
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {['admin', 'manager', 'staff'].map(role => (
          <div key={role} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="p-4 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
              <h3 className="font-bold text-gray-900 capitalize flex items-center gap-2">
                {role === 'admin' && <Shield size={18} className="text-red-500" />}
                {role === 'manager' && <Users size={18} className="text-blue-500" />}
                {role === 'staff' && <User size={18} className="text-green-500" />}
                {role}s
              </h3>
              <span className="bg-gray-200 text-gray-700 text-xs px-2 py-1 rounded-full font-bold">
                {users.filter(u => u.role === role).length}
              </span>
            </div>
            <div className="divide-y divide-gray-50">
              {users.filter(u => u.role === role).map(user => (
                <div key={user.id} className="p-4 flex items-center justify-between hover:bg-gray-50 transition-colors">
                  <div>
                    <p className="font-medium text-gray-900">{user.name}</p>
                    <p className="text-xs text-gray-500">{user.email}</p>
                    {user.role === 'staff' && user.managerId && (
                      <p className="text-[10px] text-blue-600 font-bold mt-1">
                        Under: {users.find(u => u.id === user.managerId)?.name || 'Unknown'}
                      </p>
                    )}
                  </div>
                  <button 
                    onClick={() => handleDeleteUser(user.id)}
                    className="text-gray-400 hover:text-red-500 transition-colors p-1"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              {users.filter(u => u.role === role).length === 0 && (
                <div className="p-8 text-center text-gray-400 text-sm">No {role}s added yet.</div>
              )}
            </div>
          </div>
        ))}
      </div>

      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="p-6 bg-gray-50 border-b border-gray-100">
              <h3 className="text-xl font-bold text-gray-900">Add New Team Member</h3>
            </div>
            <form onSubmit={handleAddUser} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
                <input 
                  required
                  type="text" 
                  value={newUser.name}
                  onChange={e => setNewUser({...newUser, name: e.target.value})}
                  className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-black outline-none"
                  placeholder="e.g. John Doe"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Gmail Address</label>
                <input 
                  required
                  type="email" 
                  value={newUser.email}
                  onChange={e => setNewUser({...newUser, email: e.target.value})}
                  className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-black outline-none"
                  placeholder="e.g. user@gmail.com"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                <select 
                  value={newUser.role}
                  onChange={e => setNewUser({...newUser, role: e.target.value as any})}
                  className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-black outline-none"
                >
                  <option value="staff">Staff (Telecaller)</option>
                  <option value="manager">Manager</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              {newUser.role === 'staff' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Assign to Manager</label>
                  <select 
                    required
                    value={newUser.managerId}
                    onChange={e => setNewUser({...newUser, managerId: e.target.value})}
                    className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-black outline-none"
                  >
                    <option value="">Select a Manager</option>
                    {managers.map(m => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex gap-3 pt-4">
                <button 
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 px-4 py-2 border rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button 
                  type="submit"
                  className="flex-1 px-4 py-2 bg-black text-white rounded-lg hover:bg-gray-800 transition-colors font-bold"
                >
                  Create Member
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
