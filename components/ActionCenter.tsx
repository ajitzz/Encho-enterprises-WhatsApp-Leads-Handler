
import React, { useState, useEffect } from 'react';
import { 
  Zap, 
  Clock, 
  AlertTriangle, 
  CheckCircle, 
  ChevronRight, 
  Loader2, 
  Inbox,
  Calendar,
  MessageSquare
} from 'lucide-react';
import { liveApiService } from '../services/liveApiService.ts';

interface ActionCenterProps {
  staffId: string;
  onSelectLead: (leadId: string) => void;
}

export const ActionCenter: React.FC<ActionCenterProps> = ({ staffId, onSelectLead }) => {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const result = await liveApiService.getActionCenter(staffId);
        setData(result);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [staffId]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <Loader2 className="animate-spin text-blue-600 mb-2" size={32} />
        <p className="text-sm text-gray-500 font-medium">Loading your Action Center...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-center">
        <div className="bg-red-50 text-red-600 p-4 rounded-2xl border border-red-100">
          <p className="text-sm font-bold">Failed to load Action Center</p>
          <p className="text-xs mt-1">{error}</p>
        </div>
      </div>
    );
  }

  const { newLeads, reminders, staleLeads } = data || { newLeads: [], reminders: [], staleLeads: [] };

  return (
    <div className="p-4 space-y-6 animate-in fade-in duration-300">
      {/* Summary Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white p-3 rounded-2xl border border-gray-100 shadow-sm text-center">
          <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">New</p>
          <p className="text-xl font-bold text-blue-600">{newLeads.length}</p>
        </div>
        <div className="bg-white p-3 rounded-2xl border border-gray-100 shadow-sm text-center">
          <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Tasks</p>
          <p className="text-xl font-bold text-amber-600">{reminders.length}</p>
        </div>
        <div className="bg-white p-3 rounded-2xl border border-gray-100 shadow-sm text-center">
          <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Stale</p>
          <p className="text-xl font-bold text-red-600">{staleLeads.length}</p>
        </div>
      </div>

      {/* New Leads Section */}
      {newLeads.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-xs font-bold text-gray-900 flex items-center gap-2 px-1">
            <Zap size={14} className="text-blue-600" />
            New Assignments
          </h3>
          <div className="space-y-2">
            {newLeads.map((lead: any) => (
              <button 
                key={lead.id}
                onClick={() => onSelectLead(lead.id)}
                className="w-full bg-blue-50 border border-blue-100 p-4 rounded-2xl flex items-center justify-between group hover:bg-blue-100 transition-all"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center font-bold">
                    {lead.name.charAt(0)}
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-bold text-gray-900">{lead.name}</p>
                    <p className="text-[10px] text-blue-600 font-bold uppercase tracking-wider">Just Assigned</p>
                  </div>
                </div>
                <ChevronRight size={18} className="text-blue-300 group-hover:text-blue-600" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Reminders Section */}
      {reminders.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-xs font-bold text-gray-900 flex items-center gap-2 px-1">
            <Calendar size={14} className="text-amber-600" />
            Scheduled Tasks
          </h3>
          <div className="space-y-2">
            {reminders.map((reminder: any) => (
              <button 
                key={reminder.id}
                onClick={() => onSelectLead(reminder.lead_id)}
                className="w-full bg-white border border-gray-100 p-4 rounded-2xl flex items-center justify-between group hover:bg-gray-50 transition-all"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center font-bold">
                    <Clock size={20} />
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-bold text-gray-900">{reminder.lead_name}</p>
                    <p className="text-[10px] text-amber-600 font-bold uppercase tracking-wider">
                      {new Date(reminder.scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                </div>
                <ChevronRight size={18} className="text-gray-300 group-hover:text-gray-900" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Stale Leads Section */}
      {staleLeads.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-xs font-bold text-gray-900 flex items-center gap-2 px-1">
            <AlertTriangle size={14} className="text-red-600" />
            Attention Required (Stale)
          </h3>
          <div className="space-y-2">
            {staleLeads.map((lead: any) => (
              <button 
                key={lead.id}
                onClick={() => onSelectLead(lead.id)}
                className="w-full bg-red-50 border border-red-100 p-4 rounded-2xl flex items-center justify-between group hover:bg-red-100 transition-all"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-red-100 text-red-600 flex items-center justify-center font-bold">
                    <AlertTriangle size={20} />
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-bold text-gray-900">{lead.name}</p>
                    <p className="text-[10px] text-red-600 font-bold uppercase tracking-wider">No activity for 24h+</p>
                  </div>
                </div>
                <ChevronRight size={18} className="text-red-300 group-hover:text-red-600" />
              </button>
            ))}
          </div>
        </div>
      )}

      {newLeads.length === 0 && reminders.length === 0 && staleLeads.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mb-4">
            <Inbox size={40} className="text-gray-300" />
          </div>
          <h3 className="text-sm font-bold text-gray-900">Inbox Zero!</h3>
          <p className="text-xs text-gray-500 mt-1 px-10">You're all caught up. Great job managing your leads!</p>
        </div>
      )}
    </div>
  );
};
