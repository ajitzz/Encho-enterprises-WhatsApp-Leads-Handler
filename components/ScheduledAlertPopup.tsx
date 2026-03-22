import React from 'react';
import { BellRing, CalendarClock, X } from 'lucide-react';
import { DueAlertItem } from '../services/liveApiService.ts';

interface ScheduledAlertPopupProps {
  alert: DueAlertItem | null;
  onDismiss: () => void;
  onOpenLead?: (leadId: string) => void;
}

export const ScheduledAlertPopup: React.FC<ScheduledAlertPopupProps> = ({ alert, onDismiss, onOpenLead }) => {
  if (!alert) return null;

  const title = alert.event_type === 'review_due' ? 'Closing Review Due' : 'Follow-up Due Now';
  const subtitle = alert.event_type === 'review_due'
    ? 'Closing date reached. Please process the review immediately.'
    : 'Scheduled follow-up time has arrived.';

  return (
    <div className="fixed inset-0 z-[120] bg-black/45 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-amber-100 text-amber-700">
              <BellRing size={18} />
            </div>
            <div>
              <h3 className="font-extrabold text-gray-900">{title}</h3>
              <p className="text-xs text-gray-500">{subtitle}</p>
            </div>
          </div>
          <button onClick={onDismiss} className="text-gray-400 hover:text-gray-900 transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div className="rounded-xl bg-gray-50 border border-gray-100 p-3">
            <p className="text-xs uppercase tracking-widest text-gray-400 font-bold">Lead</p>
            <p className="text-sm font-bold text-gray-900">{alert.lead_name}</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="rounded-xl bg-gray-50 border border-gray-100 p-3">
              <p className="text-xs uppercase tracking-widest text-gray-400 font-bold">Scheduled Time</p>
              <p className="text-sm font-semibold text-gray-900 flex items-center gap-1.5 mt-1">
                <CalendarClock size={14} />
                {new Date(alert.scheduled_at).toLocaleString()}
              </p>
            </div>
            <div className="rounded-xl bg-gray-50 border border-gray-100 p-3">
              <p className="text-xs uppercase tracking-widest text-gray-400 font-bold">Owner</p>
              <p className="text-sm font-semibold text-gray-900 mt-1">{alert.owner_staff_name || 'Unassigned'}</p>
            </div>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-gray-100 flex items-center justify-end gap-2">
          <button onClick={onDismiss} className="px-4 py-2 rounded-lg border border-gray-200 text-gray-700 text-sm font-semibold hover:bg-gray-50">
            Dismiss
          </button>
          <button
            onClick={() => {
              onOpenLead?.(alert.lead_id);
              onDismiss();
            }}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700"
          >
            Open Lead
          </button>
        </div>
      </div>
    </div>
  );
};
