import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle,
  XCircle,
  Loader2,
  ArrowLeft,
  FileText,
  ExternalLink,
  MessageSquare,
  AlertCircle,
  RotateCcw,
  Inbox,
  BadgeCheck,
  Ban,
  Undo2
} from 'lucide-react';
import { liveApiService } from '../services/liveApiService.ts';

type InboxStatus = 'pending' | 'approved' | 'rejected' | 'returned_for_call_again';
type DecisionStatus = 'approved' | 'rejected' | 'returned_for_call_again';

interface PendingReviewsProps {
  managerId: string;
  onBack: () => void;
}

const STATUS_META: Record<InboxStatus, { label: string; icon: React.ReactNode }> = {
  pending: { label: 'Pending', icon: <Inbox size={14} /> },
  approved: { label: 'Approved', icon: <BadgeCheck size={14} /> },
  rejected: { label: 'Rejected', icon: <Ban size={14} /> },
  returned_for_call_again: { label: 'Returned', icon: <Undo2 size={14} /> }
};

const DECISION_REASONS: Record<DecisionStatus, string[]> = {
  approved: ['ready_for_closure', 'verified_details', 'other'],
  rejected: ['duplicate_lead', 'invalid_contact', 'not_qualified', 'other'],
  returned_for_call_again: ['no_answer', 'call_later', 'missing_confirmation', 'other']
};

export const PendingReviews: React.FC<PendingReviewsProps> = ({ managerId, onBack }) => {
  const [reviews, setReviews] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [reasonCode, setReasonCode] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<InboxStatus>('pending');

  const fetchReviews = async (status: InboxStatus) => {
    try {
      setLoading(true);
      setError(null);
      const data = await liveApiService.getPendingReviews(managerId, status);
      setReviews(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReviews(activeTab);
  }, [managerId, activeTab]);

  const getRequiredReasonError = (reviewId: string, decision: DecisionStatus) => {
    if (decision === 'approved') return null;
    const currentReason = reasonCode[reviewId];
    if (!currentReason) return 'Select a reason before submitting this decision.';
    return null;
  };

  const handleDecision = async (reviewId: string, decision: DecisionStatus) => {
    const reasonError = getRequiredReasonError(reviewId, decision);
    if (reasonError) {
      setError(reasonError);
      return;
    }

    try {
      setProcessingId(reviewId);
      setError(null);
      await liveApiService.reviewDecision(reviewId, {
        decision,
        feedback: feedback[reviewId] || '',
        reasonCode: reasonCode[reviewId] || ''
      });

      if (activeTab === 'pending') {
        setReviews(prev => prev.filter(r => r.id !== reviewId));
      } else {
        await fetchReviews(activeTab);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setProcessingId(null);
    }
  };

  const emptyStateText = useMemo(() => {
    if (activeTab === 'approved') return 'No approved leads yet.';
    if (activeTab === 'rejected') return 'No rejected leads yet.';
    if (activeTab === 'returned_for_call_again') return 'No returned leads yet.';
    return 'No pending reviews. Good job!';
  }, [activeTab]);

  const isHistoryTab = activeTab !== 'pending';

  return (
    <div className="flex flex-col h-full bg-gray-50 animate-in slide-in-from-right duration-300">
      <div className="p-4 bg-white border-b border-gray-100 sticky top-0 z-10 space-y-4">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
            <ArrowLeft size={20} />
          </button>
          <h2 className="text-lg font-bold">Review Inbox</h2>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {(Object.keys(STATUS_META) as InboxStatus[]).map((status) => (
            <button
              key={status}
              onClick={() => setActiveTab(status)}
              className={`flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-bold transition-all border ${
                activeTab === status
                  ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'
              }`}
            >
              {STATUS_META[status].icon}
              {STATUS_META[status].label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading && (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="animate-spin text-blue-600 mb-2" size={32} />
            <p className="text-sm text-gray-500 font-medium">Loading reviews...</p>
          </div>
        )}

        {!loading && error && (
          <div className="p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-700">
            <AlertCircle size={20} />
            <p className="text-xs font-bold">{error}</p>
          </div>
        )}

        {!loading && reviews.map(review => (
          <div key={review.id} className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold">
                  {(review.lead_name || 'L').charAt(0)}
                </div>
                <div>
                  <h4 className="font-bold text-gray-900">{review.lead_name}</h4>
                  <p className="text-[10px] text-gray-400 uppercase font-bold tracking-widest">Submitted by {review.staff_name}</p>
                </div>
              </div>
              <span className="px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest bg-gray-100 text-gray-700">
                {STATUS_META[(review.status as InboxStatus) || activeTab]?.label || review.status}
              </span>
            </div>

            <div className="bg-gray-50 p-4 rounded-2xl space-y-2">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest flex items-center gap-1">
                <FileText size={10} /> Staff Notes
              </p>
              <p className="text-sm text-gray-700 leading-relaxed">{review.notes}</p>
            </div>

            {review.screenshot_url && (
              <div className="rounded-2xl overflow-hidden border border-gray-100">
                <img src={review.screenshot_url} alt="Closing Proof" className="w-full h-auto" referrerPolicy="no-referrer" />
                <a
                  href={review.screenshot_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 p-3 bg-gray-50 text-blue-600 text-[10px] font-bold uppercase tracking-widest hover:bg-gray-100 transition-all"
                >
                  <ExternalLink size={12} /> View Full Image
                </a>
              </div>
            )}

            {!isHistoryTab && (
              <div className="space-y-3 pt-2">
                <div className="relative">
                  <MessageSquare className="absolute left-4 top-4 text-gray-400" size={16} />
                  <textarea
                    placeholder="Add reviewer feedback for staff..."
                    className="w-full pl-12 pr-4 py-3.5 rounded-2xl bg-gray-50 border-none text-xs focus:ring-2 focus:ring-blue-500 transition-all min-h-[80px] resize-none"
                    value={feedback[review.id] || ''}
                    onChange={e => setFeedback(prev => ({ ...prev, [review.id]: e.target.value }))}
                  />
                </div>

                <select
                  className="w-full px-4 py-3 rounded-2xl bg-gray-50 border-none text-xs font-semibold text-gray-700 focus:ring-2 focus:ring-blue-500"
                  value={reasonCode[review.id] || ''}
                  onChange={(e) => setReasonCode(prev => ({ ...prev, [review.id]: e.target.value }))}
                >
                  <option value="">Select decision reason (required for Reject/Return)</option>
                  {Array.from(new Set([...DECISION_REASONS.rejected, ...DECISION_REASONS.returned_for_call_again])).map((reason) => (
                    <option key={reason} value={reason}>{reason.replaceAll('_', ' ')}</option>
                  ))}
                </select>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <button
                    onClick={() => handleDecision(review.id, 'returned_for_call_again')}
                    disabled={!!processingId}
                    className="bg-amber-50 text-amber-700 py-3 rounded-2xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-amber-100 transition-all active:scale-95 disabled:opacity-50"
                  >
                    {processingId === review.id ? <Loader2 className="animate-spin" size={16} /> : <><RotateCcw size={16} /> Return</>}
                  </button>
                  <button
                    onClick={() => handleDecision(review.id, 'rejected')}
                    disabled={!!processingId}
                    className="bg-red-50 text-red-600 py-3 rounded-2xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-red-100 transition-all active:scale-95 disabled:opacity-50"
                  >
                    {processingId === review.id ? <Loader2 className="animate-spin" size={16} /> : <><XCircle size={16} /> Reject</>}
                  </button>
                  <button
                    onClick={() => handleDecision(review.id, 'approved')}
                    disabled={!!processingId}
                    className="bg-emerald-600 text-white py-3 rounded-2xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-emerald-700 transition-all active:scale-95 disabled:opacity-50 shadow-lg shadow-emerald-200"
                  >
                    {processingId === review.id ? <Loader2 className="animate-spin" size={16} /> : <><CheckCircle size={16} /> Approve</>}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}

        {!loading && reviews.length === 0 && (
          <div className="text-center py-20">
            <div className="bg-gray-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle size={32} className="text-gray-300" />
            </div>
            <p className="text-gray-500 font-medium">{emptyStateText}</p>
          </div>
        )}
      </div>
    </div>
  );
};
