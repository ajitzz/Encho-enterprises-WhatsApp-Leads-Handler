import React, { useState } from 'react';
import { Lead, LeadStatus } from '../types';
import { MessageCircle, Check, X, AlertCircle, Youtube, Search, Filter } from 'lucide-react';

interface LeadTableProps {
  drivers: Lead[]; // Kept prop name as drivers to avoid breaking parent usage
  onSelectDriver: (driver: Lead) => void;
  onSendWelcome: (driver: Lead) => void;
  onBulkSelect: (ids: string[]) => void;
  selectedIds: string[];
}

export const LeadTable: React.FC<LeadTableProps> = ({ 
  drivers, 
  onSelectDriver, 
  onSendWelcome,
  onBulkSelect,
  selectedIds
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('All');

  const getStatusColor = (status: LeadStatus) => {
    switch (status) {
      case LeadStatus.NEW: return 'bg-blue-100 text-blue-800 border-blue-200';
      case LeadStatus.QUALIFIED: return 'bg-green-100 text-green-800 border-green-200';
      case LeadStatus.FLAGGED_FOR_REVIEW: return 'bg-amber-100 text-amber-800 border-amber-200';
      case LeadStatus.REJECTED: return 'bg-red-100 text-red-800 border-red-200';
      case LeadStatus.ONBOARDED: return 'bg-purple-100 text-purple-800 border-purple-200';
      default: return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const filteredDrivers = drivers.filter(d => {
    const matchesSearch = d.name.toLowerCase().includes(searchTerm.toLowerCase()) || d.phoneNumber.includes(searchTerm);
    const matchesFilter = filterStatus === 'All' || d.status === filterStatus;
    return matchesSearch && matchesFilter;
  });

  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      onBulkSelect(filteredDrivers.map(d => d.id));
    } else {
      onBulkSelect([]);
    }
  };

  const handleSelectOne = (id: string) => {
    if (selectedIds.includes(id)) {
      onBulkSelect(selectedIds.filter(sid => sid !== id));
    } else {
      onBulkSelect([...selectedIds, id]);
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 flex flex-col h-full">
      {/* Header / Toolbar */}
      <div className="p-4 border-b border-gray-100 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-lg border border-gray-200 flex-1 max-w-md">
          <Search size={18} className="text-gray-400" />
          <input 
            type="text" 
            placeholder="Search name or phone..." 
            className="bg-transparent border-none outline-none w-full text-sm"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        
        <div className="flex items-center gap-2">
          <Filter size={18} className="text-gray-400" />
          <select 
            className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none cursor-pointer"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
          >
            <option value="All">All Statuses</option>
            {Object.values(LeadStatus).map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-auto flex-1">
        <table className="w-full text-left border-collapse">
          <thead className="bg-gray-50 sticky top-0 z-10">
            <tr>
              <th className="p-4 border-b border-gray-200 w-10">
                <input 
                  type="checkbox" 
                  className="rounded border-gray-300"
                  checked={selectedIds.length === filteredDrivers.length && filteredDrivers.length > 0}
                  onChange={handleSelectAll}
                />
              </th>
              <th className="p-4 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider">Driver Details</th>
              <th className="p-4 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
              <th className="p-4 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider">Last Message</th>
              <th className="p-4 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filteredDrivers.map((driver) => (
              <tr 
                key={driver.id} 
                className="hover:bg-blue-50/30 transition-colors cursor-pointer group"
                onClick={() => onSelectDriver(driver)}
              >
                <td className="p-4" onClick={(e) => e.stopPropagation()}>
                  <input 
                    type="checkbox" 
                    className="rounded border-gray-300"
                    checked={selectedIds.includes(driver.id)}
                    onChange={() => handleSelectOne(driver.id)}
                  />
                </td>
                <td className="p-4">
                  <div className="flex flex-col">
                    <span className="font-medium text-gray-900">{driver.name}</span>
                    <span className="text-xs text-gray-400 font-mono mt-0.5">{driver.phoneNumber}</span>
                  </div>
                </td>
                <td className="p-4">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${getStatusColor(driver.status)}`}>
                    {driver.status}
                  </span>
                </td>
                <td className="p-4">
                  <div className="max-w-xs truncate text-sm text-gray-700 font-medium">
                    {driver.lastMessage}
                  </div>
                  <div className="text-[11px] text-gray-400 mt-1 font-mono">
                    {new Date(driver.lastMessageTime).toLocaleString([], { 
                        year: 'numeric', month: 'short', day: 'numeric', 
                        hour: '2-digit', minute: '2-digit' 
                    })}
                  </div>
                </td>
                <td className="p-4 text-right">
                  <div className="flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                    <button 
                      onClick={() => onSendWelcome(driver)}
                      className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors tooltip"
                      title="Send Welcome Video"
                    >
                      <Youtube size={18} />
                    </button>
                    <button 
                      onClick={() => onSelectDriver(driver)}
                      className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                      title="Open Chat"
                    >
                      <MessageCircle size={18} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        
        {filteredDrivers.length === 0 && (
          <div className="flex flex-col items-center justify-center p-12 text-gray-400">
            <Search size={48} className="mb-4 opacity-20" />
            <p>No drivers found matching your criteria.</p>
          </div>
        )}
      </div>
    </div>
  );
};