
import React, { useState, useEffect } from 'react';
import { 
  CheckCircle, 
  XCircle, 
  Clock, 
  Loader2, 
  ArrowLeft, 
  Calendar, 
  FileText, 
  ExternalLink,
  MessageSquare,
  AlertCircle
} from 'lucide-react';
import { liveApiService } from '../services/liveApiService.ts';

interface PendingReviewsProps {
  managerId: string;
  onBack: () => void;
}

export const PendingReviews: React.FC<PendingReviewsProps> = ({ managerId, onBack }) => {
  const [reviews, setReviews] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, string>>({});

  const fetchReviews = async () => {
    try {
      setLoading(true);
      const data = await liveApiService.getPendingReviews(managerId);
      setReviews(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReviews();
  }, [managerId]);

  const handleDecision = async (reviewId: string, decision: 'approved' | 'rejected') => {
    try {
      setProcessingId(reviewId);
      await liveApiService.reviewDecision(reviewId, {
        decision,
        feedback: feedback[reviewId] || ''
      });
      setReviews(prev => prev.filter(r => r.id !== reviewId));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setProcessingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <Loader2 className="animate-spin text-blue-600 mb-2" size={32} />
        <p className="text-sm text-gray-500 font-medium">Loading pending reviews...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gray-50 animate-in slide-in-from-right duration-300">
      <div className="p-4 bg-white border-b border-gray-100 sticky top-0 z-10">
        <div className="flex items-center gap-3 mb-4">
          <button onClick={onBack} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
            <ArrowLeft size={20} />
          </button>
          <h2 className="text-lg font-bold">Pending Reviews</h2>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {error && (
          <div className="p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-700">
            <AlertCircle size={20} />
            <p className="text-xs font-bold">{error}</p>
          </div>
        )}

        {reviews.map(review => (
          <div key={review.id} className="bg-white p-5 rounded-3xl border border-gray-100 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold">
                  {review.lead_name.charAt(0)}
                </div>
                <div>
                  <h4 className="font-bold text-gray-900">{review.lead_name}</h4>
                  <p className="text-[10px] text-gray-400 uppercase font-bold tracking-widest">Submitted by {review.staff_name}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">Closing Date</p>
                <p className="text-xs font-bold text-gray-900">{new Date(review.closing_date).toLocaleDateString()}</p>
              </div>
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

            <div className="space-y-3 pt-2">
              <div className="relative">
                <MessageSquare className="absolute left-4 top-4 text-gray-400" size={16} />
                <textarea 
                  placeholder="Add feedback for the staff member (optional)..."
                  className="w-full pl-12 pr-4 py-3.5 rounded-2xl bg-gray-50 border-none text-xs focus:ring-2 focus:ring-blue-500 transition-all min-h-[80px] resize-none"
                  value={feedback[review.id] || ''}
                  onChange={e => setFeedback(prev => ({ ...prev, [review.id]: e.target.value }))}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
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
          </div>
        ))}

        {reviews.length === 0 && (
          <div className="text-center py-20">
            <div className="bg-gray-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle size={32} className="text-gray-300" />
            </div>
            <p className="text-gray-500 font-medium">No pending reviews. Good job!</p>
          </div>
        )}
      </div>
    </div>
  );
};
