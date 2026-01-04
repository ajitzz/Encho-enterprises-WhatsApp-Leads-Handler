import React, { useState } from 'react';
import { X, CheckCircle, AlertCircle, Loader2, Globe, Shield, Key } from 'lucide-react';
import { liveApiService } from '../services/liveApiService';

interface WebhookConfigModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

export const WebhookConfigModal: React.FC<WebhookConfigModalProps> = ({ onClose, onSuccess }) => {
  const [formData, setFormData] = useState({
    appId: '',
    appSecret: '',
    webhookUrl: '',
    verifyToken: 'uber_fleet_verify_token'
  });
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('loading');
    setErrorMessage('');

    // Ensure URL ends with /webhook if not present, and is valid
    let url = formData.webhookUrl.trim();
    if (!url.startsWith('http')) {
        setErrorMessage('URL must start with https://');
        setStatus('error');
        return;
    }
    if (!url.endsWith('/webhook')) {
        url = url.replace(/\/$/, '') + '/webhook';
    }

    try {
      await liveApiService.configureWebhook({
        ...formData,
        webhookUrl: url
      });
      setStatus('success');
      setTimeout(() => {
        onSuccess();
        onClose();
      }, 2000);
    } catch (err: any) {
      setStatus('error');
      setErrorMessage(err.message || 'Failed to configure webhook');
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        
        {/* Header */}
        <div className="bg-gray-900 text-white p-4 flex justify-between items-center">
          <h3 className="font-bold flex items-center gap-2">
            <Globe size={18} />
            Configure Meta Webhook
          </h3>
          <button onClick={onClose} className="hover:bg-gray-800 p-1 rounded-full transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          
          <div className="bg-blue-50 text-blue-800 text-xs p-3 rounded-lg border border-blue-100 mb-4">
            This will automatically update your Meta App settings to point to your backend server.
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Meta App ID</label>
              <div className="relative">
                <input 
                  type="text" 
                  required
                  className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  placeholder="e.g., 123456789"
                  value={formData.appId}
                  onChange={(e) => setFormData({...formData, appId: e.target.value})}
                />
                <Shield size={16} className="absolute left-3 top-2.5 text-gray-400" />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">App Secret</label>
              <div className="relative">
                <input 
                  type="password" 
                  required
                  className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  placeholder="e.g., a1b2c3d4..."
                  value={formData.appSecret}
                  onChange={(e) => setFormData({...formData, appSecret: e.target.value})}
                />
                <Key size={16} className="absolute left-3 top-2.5 text-gray-400" />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Ngrok URL (Public Server URL)</label>
              <div className="relative">
                <input 
                  type="url" 
                  required
                  className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  placeholder="https://xxxx.ngrok-free.app"
                  value={formData.webhookUrl}
                  onChange={(e) => setFormData({...formData, webhookUrl: e.target.value})}
                />
                <Globe size={16} className="absolute left-3 top-2.5 text-gray-400" />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Verify Token</label>
              <input 
                type="text" 
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none bg-gray-50"
                value={formData.verifyToken}
                onChange={(e) => setFormData({...formData, verifyToken: e.target.value})}
              />
            </div>
          </div>

          {status === 'error' && (
            <div className="flex items-start gap-2 text-red-600 text-xs bg-red-50 p-2 rounded border border-red-100">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {status === 'success' && (
             <div className="flex items-center gap-2 text-green-600 text-sm bg-green-50 p-3 rounded border border-green-100 justify-center font-medium">
              <CheckCircle size={18} />
              Webhook Updated Successfully!
            </div>
          )}

          <div className="pt-2">
            <button 
              type="submit" 
              disabled={status === 'loading' || status === 'success'}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg shadow-sm transition-all flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {status === 'loading' ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  Connecting...
                </>
              ) : (
                'Save & Verify Connection'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};