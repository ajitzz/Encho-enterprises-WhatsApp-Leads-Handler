
import React, { useState } from 'react';
import { 
  X, 
  CheckCircle, 
  AlertCircle, 
  Loader2, 
  Calendar, 
  FileText, 
  Paperclip,
  Zap
} from 'lucide-react';
import { liveApiService } from '../services/liveApiService.ts';
import { getLeadScreenshotUploadPath } from '../services/mediaPaths';

interface LeadReviewModalProps {
  lead: any;
  onClose: () => void;
  onSuccess: () => void;
}

export const LeadReviewModal: React.FC<LeadReviewModalProps> = ({ lead, onClose, onSuccess }) => {
  const [closingDate, setClosingDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [screenshot, setScreenshot] = useState<{ file: File; preview: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!closingDate || !notes) return;

    try {
      setLoading(true);
      let screenshot_url = undefined;
      
      if (screenshot) {
        const upload = await liveApiService.uploadMedia(screenshot.file, getLeadScreenshotUploadPath(lead));
        screenshot_url = upload.url;
      }

      await liveApiService.submitLeadReview(lead.id, {
        closing_date: closingDate,
        notes,
        screenshot_url
      });

      onSuccess();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-md rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-10 duration-300">
        <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-white sticky top-0 z-10">
          <div className="flex items-center gap-3">
            <div className="bg-blue-100 text-blue-600 p-2 rounded-xl">
              <Zap size={20} />
            </div>
            <div>
              <h3 className="text-lg font-bold text-gray-900">Closing Review</h3>
              <p className="text-[10px] text-gray-500 uppercase font-bold tracking-widest">Lead: {lead.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5 overflow-y-auto max-h-[80vh]">
          {error && (
            <div className="p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-700">
              <AlertCircle size={20} />
              <p className="text-xs font-bold">{error}</p>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-1">Closing Date</label>
            <div className="relative">
              <Calendar className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
              <input 
                type="date"
                required
                className="w-full pl-12 pr-4 py-3.5 rounded-2xl bg-gray-50 border-none text-sm focus:ring-2 focus:ring-blue-500 transition-all"
                value={closingDate}
                onChange={e => setClosingDate(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-1">Closing Notes</label>
            <div className="relative">
              <FileText className="absolute left-4 top-4 text-gray-400" size={18} />
              <textarea 
                required
                placeholder="Describe the closing details, package, or any special notes..."
                className="w-full pl-12 pr-4 py-3.5 rounded-2xl bg-gray-50 border-none text-sm focus:ring-2 focus:ring-blue-500 transition-all min-h-[120px] resize-none"
                value={notes}
                onChange={e => setNotes(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest px-1">Proof of Closing (Optional)</label>
            <label className="flex flex-col items-center justify-center gap-2 p-6 border-2 border-dashed border-gray-200 rounded-2xl hover:border-blue-400 hover:bg-blue-50 transition-all cursor-pointer">
              {screenshot ? (
                <div className="relative w-full aspect-video">
                  <img src={screenshot.preview} className="w-full h-full object-cover rounded-xl" alt="Preview" />
                  <button 
                    type="button"
                    onClick={(e) => { e.preventDefault(); setScreenshot(null); }}
                    className="absolute -top-2 -right-2 bg-red-500 text-white p-1.5 rounded-full shadow-lg"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <>
                  <Paperclip size={24} className="text-gray-400" />
                  <span className="text-[10px] font-bold text-gray-500 uppercase">Attach Screenshot</span>
                  <p className="text-[9px] text-gray-400">Receipt, confirmation, or signed document</p>
                </>
              )}
              <input 
                type="file" 
                className="hidden" 
                accept="image/*" 
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) setScreenshot({ file, preview: URL.createObjectURL(file) });
                }} 
              />
            </label>
          </div>

          <div className="pt-4">
            <button 
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-2 disabled:opacity-50 active:scale-95 transition-all shadow-lg shadow-blue-200"
            >
              {loading ? <Loader2 className="animate-spin" size={20} /> : <><CheckCircle size={20} /> Submit for Review</>}
            </button>
            <p className="text-[9px] text-center text-gray-400 mt-4 px-6">
              Your submission will be reviewed by your manager for final approval.
            </p>
          </div>
        </form>
      </div>
    </div>
  );
};
