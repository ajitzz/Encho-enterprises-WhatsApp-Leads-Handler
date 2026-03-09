import React, { useEffect, useMemo, useState } from 'react';
import { Driver } from '../types';
import { liveApiService } from '../services/liveApiService';
import { BellRing, CheckCircle2, Clock3, MessageSquare, PhoneCall } from 'lucide-react';

interface StaffPortalProps {
  onSelectDriver: (driver: Driver) => void;
}

const formatTime = (value?: number | null) => {
  if (!value) return 'Not scheduled';
  return new Date(value).toLocaleString();
};

export const StaffPortal: React.FC<StaffPortalProps> = ({ onSelectDriver }) => {
  const [leads, setLeads] = useState<Driver[]>([]);
  const [summary, setSummary] = useState({ total: 0, overdue: 0, dueToday: 0, withoutFollowup: 0 });
  const [loading, setLoading] = useState(false);
  const [remarkDrafts, setRemarkDrafts] = useState<Record<string, string>>({});
  const [followupDrafts, setFollowupDrafts] = useState<Record<string, string>>({});

  const load = async () => {
    setLoading(true);
    try {
      const data = await liveApiService.getMyLeadQueue();
      setLeads(data.leads || []);
      setSummary(data.summary || { total: 0, overdue: 0, dueToday: 0, withoutFollowup: 0 });
    } catch (e: any) {
      alert(e.message || 'Failed to load staff queue');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  const overdueLeads = useMemo(() => leads.filter((lead) => (lead.nextFollowupAt || 0) > 0 && (lead.nextFollowupAt || 0) < Date.now()), [leads]);

  const saveFollowup = async (lead: Driver) => {
    const nextFollowupAt = followupDrafts[lead.id] ? new Date(followupDrafts[lead.id]).getTime() : (lead.nextFollowupAt || 0);
    const remark = (remarkDrafts[lead.id] || '').trim();

    await liveApiService.updateLeadFollowup(lead.id, {
      nextFollowupAt,
      outcome: lead.lastOutcome || '',
      remark
    });

    await load();
    setRemarkDrafts((prev) => ({ ...prev, [lead.id]: '' }));
  };

  return (
    <div className="p-6 space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white border rounded-xl p-4"><div className="text-xs text-gray-500">Total</div><div className="text-2xl font-bold">{summary.total}</div></div>
        <div className="bg-red-50 border border-red-200 rounded-xl p-4"><div className="text-xs text-red-600">Overdue</div><div className="text-2xl font-bold text-red-700">{summary.overdue}</div></div>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4"><div className="text-xs text-amber-700">Due Today</div><div className="text-2xl font-bold text-amber-800">{summary.dueToday}</div></div>
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4"><div className="text-xs text-blue-700">No Follow-up</div><div className="text-2xl font-bold text-blue-800">{summary.withoutFollowup}</div></div>
      </div>

      <div className="bg-white border rounded-2xl overflow-hidden">
        <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
          <h3 className="font-bold text-gray-800 flex items-center gap-2"><PhoneCall size={16} /> Staff Workbench</h3>
          <button onClick={load} className="text-xs px-3 py-1.5 border rounded-lg">{loading ? 'Refreshing...' : 'Refresh'}</button>
        </div>

        <div className="divide-y">
          {leads.length === 0 && <div className="p-6 text-sm text-gray-500">No assigned leads yet.</div>}
          {leads.map((lead) => (
            <div key={lead.id} className="p-4 space-y-3">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                <div>
                  <div className="font-semibold text-gray-900">{lead.name || 'Unnamed lead'} · {lead.phoneNumber}</div>
                  <div className="text-xs text-gray-500 mt-1 flex items-center gap-3">
                    <span className="inline-flex items-center gap-1"><Clock3 size={12} /> {formatTime(lead.nextFollowupAt)}</span>
                    {lead.lastOutcome && <span className="inline-flex items-center gap-1"><CheckCircle2 size={12} /> {lead.lastOutcome}</span>}
                    {(lead.nextFollowupAt || 0) < Date.now() && (lead.nextFollowupAt || 0) > 0 && <span className="text-red-600 inline-flex items-center gap-1"><BellRing size={12} /> Overdue</span>}
                  </div>
                </div>
                <button onClick={() => onSelectDriver(lead)} className="text-sm border rounded-lg px-3 py-1.5">Open Chat</button>
              </div>

              <div className="grid md:grid-cols-3 gap-2">
                <input
                  type="datetime-local"
                  className="border rounded-lg px-3 py-2 text-sm"
                  value={followupDrafts[lead.id] || ''}
                  onChange={(e) => setFollowupDrafts((prev) => ({ ...prev, [lead.id]: e.target.value }))}
                />
                <input
                  className="border rounded-lg px-3 py-2 text-sm md:col-span-2"
                  placeholder="Add remark / call summary"
                  value={remarkDrafts[lead.id] || ''}
                  onChange={(e) => setRemarkDrafts((prev) => ({ ...prev, [lead.id]: e.target.value }))}
                />
              </div>

              <div className="flex gap-2">
                <button onClick={() => saveFollowup(lead)} className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg inline-flex items-center gap-1"><MessageSquare size={14} /> Save Follow-up</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {overdueLeads.length > 0 && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {overdueLeads.length} leads are overdue. Prioritize these first to prevent lead leakage.
        </div>
      )}
    </div>
  );
};

