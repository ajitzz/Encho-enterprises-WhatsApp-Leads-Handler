import React, { useState, useEffect } from 'react';
import { X, CheckCircle, AlertCircle, Loader2, Globe, Shield, Key, Smartphone, Lock, Terminal, Play, RefreshCw, Bug } from 'lucide-react';
import { liveApiService } from '../services/liveApiService';

interface WebhookConfigModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

export const WebhookConfigModal: React.FC<WebhookConfigModalProps> = ({ onClose, onSuccess }) => {
  const [activeTab, setActiveTab] = useState<'creds' | 'webhook' | 'debug'>('debug');
  
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

  // Debug Data
  const [logs, setLogs] = useState<string[]>([]);
  const [simPhone, setSimPhone] = useState('919876543210');
  const [simMsg, setSimMsg] = useState('Hello');

  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  // Log Polling
  useEffect(() => {
    let interval: any;
    if (activeTab === 'debug') {
        const fetchLogs = async () => {
            const data = await liveApiService.getLogs();
            setLogs(data);
        };
        fetchLogs();
        interval = setInterval(fetchLogs, 2000);
    }
    return () => clearInterval(interval);
  }, [activeTab]);

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

  const handleSimulate = async () => {
      try {
          await liveApiService.simulateWebhook({ phone: simPhone, text: simMsg, name: 'Test User' });
          alert("Simulation Sent! Check the logs below or the dashboard.");
      } catch (e: any) {
          alert("Failed to simulate: " + e.message);
      }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="bg-gray-900 text-white p-4 flex justify-between items-center shrink-0">
          <h3 className="font-bold flex items-center gap-2">
            <Globe size={18} />
            Configure Live API
          </h3>
          <button onClick={onClose} className="hover:bg-gray-800 p-1 rounded-full transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 shrink-0">
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
             <button 
                onClick={() => { setActiveTab('debug'); }}
                className={`flex-1 py-3 text-xs font-bold flex items-center justify-center gap-1 ${activeTab === 'debug' ? 'bg-white text-amber-600 border-b-2 border-amber-600' : 'bg-gray-50 text-gray-500 hover:bg-gray-100'}`}
             >
                <Bug size={14} /> Test & Debug
             </button>
        </div>

        <div className="overflow-y-auto flex-1 p-6">
        {activeTab === 'creds' && (
             <form onSubmit={handleUpdateCreds} className="space-y-4 max-w-md mx-auto">
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
        )} 

        {activeTab === 'webhook' && (
             <form onSubmit={handleConfigureWebhook} className="space-y-4 max-w-md mx-auto">
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

        {activeTab === 'debug' && (
            <div className="space-y-4">
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                     {/* Simulator */}
                     <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                         <h4 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2">
                             <Play size={16} className="text-blue-600" /> Simulate Message
                         </h4>
                         <div className="space-y-3">
                             <input 
                               type="text" 
                               value={simPhone} 
                               onChange={e => setSimPhone(e.target.value)} 
                               placeholder="Phone Number" 
                               className="w-full border rounded p-2 text-xs"
                             />
                             <input 
                               type="text" 
                               value={simMsg} 
                               onChange={e => setSimMsg(e.target.value)} 
                               placeholder="Message" 
                               className="w-full border rounded p-2 text-xs"
                             />
                             <button onClick={handleSimulate} className="w-full bg-blue-600 text-white py-2 rounded text-xs font-bold hover:bg-blue-700">
                                 Send Simulation
                             </button>
                         </div>
                     </div>
                     {/* Info */}
                     <div className="bg-amber-50 p-4 rounded-xl border border-amber-200 text-xs text-amber-900 space-y-2">
                         <p className="font-bold flex items-center gap-2"><AlertCircle size={14} /> Why aren't messages showing?</p>
                         <p>1. Ensure your Vercel URL is set in Meta Webhook settings.</p>
                         <p>2. Verify the <strong>Verify Token</strong> matches: <code>uber_fleet_verify_token</code></p>
                         <p>3. If using local tunnel (ngrok), ensure it's running.</p>
                     </div>
                 </div>

                 {/* Logs */}
                 <div className="flex flex-col h-64 bg-gray-900 rounded-xl overflow-hidden border border-gray-700">
                     <div className="bg-gray-800 px-4 py-2 flex justify-between items-center border-b border-gray-700">
                         <span className="text-xs font-mono text-gray-400 flex items-center gap-2">
                             <Terminal size={12} /> Server Logs (Live)
                         </span>
                         <button onClick={() => setLogs([])} className="text-[10px] text-gray-500 hover:text-white">Clear</button>
                     </div>
                     <div className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-1">
                         {logs.length === 0 && <span className="text-gray-600 italic">Waiting for logs...</span>}
                         {logs.map((log, i) => (
                             <div key={i} className={`${log.includes('ERROR') ? 'text-red-400' : 'text-green-400'}`}>
                                 {log}
                             </div>
                         ))}
                     </div>
                 </div>
            </div>
        )}
        </div>
      </div>
    </div>
  );
};