import React, { useState } from 'react';
import { X, CheckCircle, AlertCircle, Loader2, Globe, Shield, Key, Smartphone, Lock } from 'lucide-react';
import { liveApiService } from '../services/liveApiService';

interface WebhookConfigModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

export const WebhookConfigModal: React.FC<WebhookConfigModalProps> = ({ onClose, onSuccess }) => {
  const [activeTab, setActiveTab] = useState<'creds' | 'webhook'>('creds');
  
  // Credentials Form
  const [credsData, setCredsData] = useState({
    phoneNumberId: '',
    apiToken: ''
  });
  
  // Webhook Form
  const [webhookData, setWebhookData] = useState({
    appId: '',
    appSecret: '',
    webhookUrl: '',
    verifyToken: 'uber_fleet_verify_token'
  });

  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const handleUpdateCreds = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('loading');
    setErrorMessage('');

    try {
        await liveApiService.updateCredentials(credsData);
        setStatus('success');
        // Do not close immediately so they can see success
    } catch (err: any) {
        setStatus('error');
        setErrorMessage(err.message || 'Failed to update credentials');
    }
  };

  const handleConfigureWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('loading');
    setErrorMessage('');

    // Ensure URL ends with /webhook if not present, and is valid
    let url = webhookData.webhookUrl.trim();
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
        ...webhookData,
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
            Configure Live API
          </h3>
          <button onClick={onClose} className="hover:bg-gray-800 p-1 rounded-full transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200">
             <button 
                onClick={() => { setActiveTab('creds'); setStatus('idle'); setErrorMessage(''); }}
                className={`flex-1 py-3 text-xs font-medium ${activeTab === 'creds' ? 'bg-white text-blue-600 border-b-2 border-blue-600' : 'bg-gray-50 text-gray-500 hover:bg-gray-100'}`}
             >
                1. Production Credentials
             </button>
             <button 
                onClick={() => { setActiveTab('webhook'); setStatus('idle'); setErrorMessage(''); }}
                className={`flex-1 py-3 text-xs font-medium ${activeTab === 'webhook' ? 'bg-white text-blue-600 border-b-2 border-blue-600' : 'bg-gray-50 text-gray-500 hover:bg-gray-100'}`}
             >
                2. Webhook Setup
             </button>
        </div>

        {activeTab === 'creds' ? (
             <form onSubmit={handleUpdateCreds} className="p-6 space-y-4">
                <div className="bg-blue-50 text-blue-800 text-xs p-3 rounded-lg border border-blue-100 mb-2">
                    Enter your <strong>Original Number ID</strong> and <strong>Permanent Token</strong> here. The server will use these to send messages.
                </div>
                <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1">Production Phone Number ID</label>
                    <div className="relative">
                        <input 
                        type="text" 
                        required
                        className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                        placeholder="e.g., 100012345678901"
                        value={credsData.phoneNumberId}
                        onChange={(e) => setCredsData({...credsData, phoneNumberId: e.target.value})}
                        />
                        <Smartphone size={16} className="absolute left-3 top-2.5 text-gray-400" />
                    </div>
                </div>
                <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1">Permanent Access Token</label>
                    <div className="relative">
                        <input 
                        type="password" 
                        required
                        className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                        placeholder="e.g., EAAG..."
                        value={credsData.apiToken}
                        onChange={(e) => setCredsData({...credsData, apiToken: e.target.value})}
                        />
                        <Lock size={16} className="absolute left-3 top-2.5 text-gray-400" />
                    </div>
                </div>
                
                {status === 'success' && (
                    <div className="flex items-center gap-2 text-green-600 text-sm bg-green-50 p-3 rounded border border-green-100 justify-center font-medium">
                        <CheckCircle size={18} />
                        Production Credentials Active!
                    </div>
                )}
                 {status === 'error' && (
                    <div className="flex items-start gap-2 text-red-600 text-xs bg-red-50 p-2 rounded border border-red-100">
                    <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
                    <span>{errorMessage}</span>
                    </div>
                )}
                
                <button 
                type="submit" 
                disabled={status === 'loading'}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg shadow-sm transition-all flex items-center justify-center gap-2 mt-4"
                >
                {status === 'loading' ? 'Updating...' : 'Set Production Credentials'}
                </button>
             </form>
        ) : (
             <form onSubmit={handleConfigureWebhook} className="p-6 space-y-4">
                <div className="bg-gray-50 text-gray-600 text-xs p-3 rounded-lg border border-gray-200 mb-4">
                    Only required if you haven't configured the Webhook in Meta Dashboard yet.
                </div>

                <div className="space-y-3">
                    <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1">Meta App ID</label>
                    <div className="relative">
                        <input 
                        type="text" 
                        required
                        className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                        value={webhookData.appId}
                        onChange={(e) => setWebhookData({...webhookData, appId: e.target.value})}
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
                        value={webhookData.appSecret}
                        onChange={(e) => setWebhookData({...webhookData, appSecret: e.target.value})}
                        />
                        <Key size={16} className="absolute left-3 top-2.5 text-gray-400" />
                    </div>
                    </div>

                    <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1">Ngrok URL</label>
                    <div className="relative">
                        <input 
                        type="url" 
                        required
                        className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                        placeholder="https://xxxx.ngrok-free.app"
                        value={webhookData.webhookUrl}
                        onChange={(e) => setWebhookData({...webhookData, webhookUrl: e.target.value})}
                        />
                        <Globe size={16} className="absolute left-3 top-2.5 text-gray-400" />
                    </div>
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
                    Webhook Updated!
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
        )}
      </div>
    </div>
  );
};