
import React, { useEffect, useState, useRef } from 'react';
import { liveApiService } from '../services/liveApiService';
import { Activity, Database, Brain, Cloud, Wifi, ArrowUpCircle, Clock, UploadCloud, MessageSquare, Shield, X, Power, AlertTriangle, Play, Pause, Lock, Zap, Server, RefreshCw } from 'lucide-react';
import { SystemStats } from '../types';

interface EnhancedStats extends SystemStats {
    dbStatus?: 'connected' | 'error' | 'unknown';
    redisStatus?: 'connected' | 'error' | 'unknown';
    qstashStatus?: 'configured' | 'missing_token' | 'unknown';
    redisLatency?: number;
}

export const SystemMonitor = () => {
    const [stats, setStats] = useState<EnhancedStats | null>(null);
    const [isOpen, setIsOpen] = useState(false);
    const [showControls, setShowControls] = useState(false);
    const [settings, setSettings] = useState({
        webhook_ingest_enabled: true,
        automation_enabled: true,
        sending_enabled: true
    });
    const [authError, setAuthError] = useState(false);
    
    // Kill Switch Modal
    const [showConfirmModal, setShowConfirmModal] = useState(false);
    const [confirmInput, setConfirmInput] = useState('');
    const [actionType, setActionType] = useState<'DISABLE' | 'ENABLE'>('DISABLE');
    
    // DB Init Status
    const [dbActionStatus, setDbActionStatus] = useState('');

    const isFetching = useRef(false);
    const timerRef = useRef<any>(null);

    useEffect(() => {
        startPolling();
        return () => stopPolling();
    }, []);

    const startPolling = async () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        const poll = async () => {
            if (isFetching.current) return;
            isFetching.current = true;
            try {
                // Check debug status explicitly to get detailed connection info
                const response = await fetch('/api/debug/status', {
                   headers: { 'Authorization': `Bearer ${localStorage.getItem('uber_fleet_auth_token')}` }
                });
                
                if (response.status === 401 || response.status === 403) {
                    setAuthError(true);
                    return;
                }
                if (response.ok) {
                    const debugStats = await response.json();
                    setStats({
                        serverLoad: 0,
                        dbLatency: 0,
                        aiCredits: 0,
                        aiModel: 'unknown',
                        s3Status: 'ok',
                        s3Load: 0,
                        whatsappStatus: 'ok',
                        whatsappUploadLoad: 0,
                        activeUploads: 0,
                        uptime: 0,
                        dbStatus: debugStats.postgres === 'connected' ? 'connected' : 'error',
                        redisStatus: debugStats.redis === 'connected' ? 'connected' : 'error',
                        qstashStatus: 'configured'
                    });
                    setAuthError(false);
                }
            } catch(e) {} finally {
                isFetching.current = false;
                if (!authError) timerRef.current = setTimeout(poll, 5000); 
            }
        };
        poll();
    };

    const stopPolling = () => {
        if (timerRef.current) clearTimeout(timerRef.current);
    };

    useEffect(() => {
        if (showControls) loadSettings();
    }, [showControls]);

    const loadSettings = async () => {
        try {
            const data = await liveApiService.getSystemSettings();
            setSettings(data);
        } catch(e) { console.error(e); }
    };

    const toggleSetting = async (key: string) => {
        const newVal = !settings[key as keyof typeof settings];
        const newSettings = { ...settings, [key]: newVal };
        setSettings(newSettings); 
        await liveApiService.updateSystemSettings(newSettings);
    };

    const handleMasterSwitch = async () => {
        const newVal = actionType === 'ENABLE';
        const newSettings = {
            webhook_ingest_enabled: newVal,
            automation_enabled: newVal,
            sending_enabled: newVal
        };
        setSettings(newSettings);
        await liveApiService.updateSystemSettings(newSettings);
        setShowConfirmModal(false);
        setConfirmInput('');
    };

    const openConfirmModal = (type: 'DISABLE' | 'ENABLE') => {
        setActionType(type);
        setConfirmInput('');
        setShowConfirmModal(true);
    };
    
    const handleInitDB = async () => {
        setDbActionStatus('Initializing Tables...');
        try {
            const res = await fetch('/api/system/init-db', { method: 'POST', headers: { 'Authorization': `Bearer ${localStorage.getItem('uber_fleet_auth_token')}` } });
            if(res.ok) setDbActionStatus('Tables Created!');
            else setDbActionStatus('Init Failed');
        } catch(e) { setDbActionStatus('Error'); }
        setTimeout(() => setDbActionStatus(''), 3000);
    };

    const handleSeedDB = async () => {
        setDbActionStatus('Seeding Data...');
        try {
            const res = await fetch('/api/system/seed-db', { method: 'POST', headers: { 'Authorization': `Bearer ${localStorage.getItem('uber_fleet_auth_token')}` } });
            if(res.ok) {
                 setDbActionStatus('Seeded! Refreshing...');
                 setTimeout(() => window.location.reload(), 1500);
            }
            else setDbActionStatus('Seed Failed');
        } catch(e) { setDbActionStatus('Error'); }
        setTimeout(() => setDbActionStatus(''), 3000);
    };

    if (authError) return null;
    if (!stats) return null;

    return (
        <>
        <div className={`fixed bottom-0 left-0 right-0 z-40 transition-transform duration-300 ${isOpen ? 'translate-y-0' : 'translate-y-[calc(100%-4px)]'}`}>
            <div 
                className={`h-1 cursor-pointer hover:h-2 transition-all ${(!settings.automation_enabled) ? 'bg-red-500 animate-pulse' : 'bg-gradient-to-r from-green-500 via-blue-500 to-purple-500'}`}
                onClick={() => setIsOpen(!isOpen)}
                title="System Monitor"
            />
            
            <div className="bg-black/90 backdrop-blur-md text-white border-t border-gray-800 p-2 flex items-center justify-between text-[10px] font-mono shadow-2xl overflow-x-auto">
                <div className="flex items-center gap-4 px-2 whitespace-nowrap">
                    {/* Database Pulse */}
                    <div className="flex items-center gap-1.5" title="Neon Postgres SSL Connection">
                        <Database size={12} className={stats.dbStatus === 'connected' ? 'text-blue-400' : 'text-red-500 animate-pulse'} />
                        <span className="text-gray-400">NEON:</span>
                        <span className={`font-bold ${stats.dbStatus === 'connected' ? 'text-white' : 'text-red-400'}`}>
                            {stats.dbStatus === 'connected' ? `CONNECTED` : 'ERR'}
                        </span>
                    </div>

                    {/* Redis Pulse */}
                    <div className="flex items-center gap-1.5" title="Upstash Redis Cache">
                        <Zap size={12} className={stats.redisStatus === 'connected' ? 'text-yellow-400' : 'text-red-500 animate-pulse'} />
                        <span className="text-gray-400">REDIS:</span>
                        <span className={`font-bold ${stats.redisStatus === 'connected' ? 'text-white' : 'text-red-400'}`}>
                            {stats.redisStatus === 'connected' ? 'OK' : 'ERR'}
                        </span>
                    </div>

                    {/* QStash Pulse */}
                    <div className="flex items-center gap-1.5" title="QStash Queue Worker">
                        <Server size={12} className={stats.qstashStatus === 'configured' ? 'text-purple-400' : 'text-gray-500'} />
                        <span className="text-gray-400">QSTASH:</span>
                        <span className="font-bold">{stats.qstashStatus === 'configured' ? 'ACTIVE' : 'MISSING'}</span>
                    </div>

                    <div className="w-px h-3 bg-gray-700 mx-1" />

                    {/* Automation Status */}
                    <div 
                        className={`flex items-center gap-1.5 px-2 py-0.5 rounded cursor-pointer transition-colors ${(!settings.automation_enabled) ? 'bg-red-900/50 text-red-300' : 'hover:bg-gray-800 text-green-400'}`}
                        onClick={() => setShowControls(true)}
                    >
                        <Shield size={12} className={(!settings.automation_enabled) ? 'text-red-500 animate-pulse' : 'text-green-500'} />
                        <span className="font-bold">{!settings.automation_enabled ? 'SYSTEM PAUSED' : 'ALL SYSTEMS GO'}</span>
                    </div>
                </div>

                <button onClick={() => setIsOpen(false)} className="text-gray-500 hover:text-white ml-2 px-2">
                    <ArrowUpCircle size={14} className="rotate-180" />
                </button>
            </div>
        </div>

        {/* CONTROLS MODAL */}
        {showControls && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
                <div className="bg-gray-900 rounded-xl shadow-2xl w-full max-w-lg border border-gray-700 animate-in zoom-in-95">
                    <div className="p-5 border-b border-gray-800 flex items-center justify-between">
                        <h3 className="font-bold text-white flex items-center gap-2">
                            <Shield size={20} className="text-blue-500" />
                            Secure Infrastructure Control
                        </h3>
                        <button onClick={() => setShowControls(false)} className="text-gray-400 hover:text-white"><X size={20} /></button>
                    </div>
                    
                    <div className="p-6 space-y-6">
                        {/* Data Issues Fixer */}
                        <div className="bg-blue-900/20 border border-blue-800 p-4 rounded-lg">
                            <div className="flex items-center justify-between mb-2">
                                <h4 className="text-blue-400 font-bold text-sm">Troubleshoot: Values Not Showing?</h4>
                                {dbActionStatus && <span className="text-xs font-mono text-green-400">{dbActionStatus}</span>}
                            </div>
                            <div className="flex gap-2">
                                <button onClick={handleInitDB} className="flex-1 bg-blue-700 hover:bg-blue-600 text-white text-xs py-2 rounded font-bold">1. Initialize Tables</button>
                                <button onClick={handleSeedDB} className="flex-1 bg-blue-700 hover:bg-blue-600 text-white text-xs py-2 rounded font-bold">2. Seed Dummy Data</button>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 gap-4">
                            <div className="flex items-center justify-between bg-gray-800 p-4 rounded-lg border border-gray-700">
                                <div><h4 className="text-white font-bold text-sm">Webhook Ingest</h4><p className="text-gray-400 text-xs">Accept messages from Meta.</p></div>
                                <div onClick={() => toggleSetting('webhook_ingest_enabled')} className={`w-12 h-6 rounded-full p-1 cursor-pointer transition-colors ${settings.webhook_ingest_enabled ? 'bg-green-600' : 'bg-gray-600'}`}><div className={`w-4 h-4 bg-white rounded-full shadow-md transform transition-transform ${settings.webhook_ingest_enabled ? 'translate-x-6' : 'translate-x-0'}`} /></div>
                            </div>
                            <div className="flex items-center justify-between bg-gray-800 p-4 rounded-lg border border-gray-700">
                                <div><h4 className="text-white font-bold text-sm">Bot Automation</h4><p className="text-gray-400 text-xs">Process messages logic.</p></div>
                                <div onClick={() => toggleSetting('automation_enabled')} className={`w-12 h-6 rounded-full p-1 cursor-pointer transition-colors ${settings.automation_enabled ? 'bg-green-600' : 'bg-gray-600'}`}><div className={`w-4 h-4 bg-white rounded-full shadow-md transform transition-transform ${settings.automation_enabled ? 'translate-x-6' : 'translate-x-0'}`} /></div>
                            </div>
                        </div>

                        <div className="pt-4 border-t border-gray-800 grid grid-cols-2 gap-4">
                            <button onClick={() => openConfirmModal('ENABLE')} className="bg-green-600 hover:bg-green-700 text-white py-3 rounded-lg font-bold text-sm flex items-center justify-center gap-2 shadow-lg"><Play size={16} /> Resume All</button>
                            <button onClick={() => openConfirmModal('DISABLE')} className="bg-red-600 hover:bg-red-700 text-white py-3 rounded-lg font-bold text-sm flex items-center justify-center gap-2 shadow-lg animate-pulse"><Power size={16} /> EMERGENCY STOP</button>
                        </div>
                    </div>
                </div>
            </div>
        )}

        {/* CONFIRMATION MODAL */}
        {showConfirmModal && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
                <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden animate-in zoom-in-95">
                    <div className={`p-6 text-center ${actionType === 'DISABLE' ? 'bg-red-50' : 'bg-green-50'}`}>
                        <div className={`mx-auto w-12 h-12 rounded-full flex items-center justify-center mb-4 ${actionType === 'DISABLE' ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'}`}>{actionType === 'DISABLE' ? <AlertTriangle size={24} /> : <Lock size={24} />}</div>
                        <h3 className="text-lg font-bold text-gray-900 mb-2">{actionType === 'DISABLE' ? 'Disable Automation?' : 'Enable Automation?'}</h3>
                        <p className="text-sm text-gray-600 mb-6">{actionType === 'DISABLE' ? 'This will stop the Bot Logic immediately.' : 'This will reactivate Bot Logic.'}</p>
                        <div className="mb-4">
                            <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Type <span className="font-mono text-black">{actionType}</span> to confirm</label>
                            <input type="text" value={confirmInput} onChange={(e) => setConfirmInput(e.target.value.toUpperCase())} className="w-full border border-gray-300 rounded-lg p-2 text-center font-bold tracking-widest outline-none focus:ring-2 focus:ring-black" autoFocus />
                        </div>
                        <div className="flex gap-3">
                            <button onClick={() => setShowConfirmModal(false)} className="flex-1 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50">Cancel</button>
                            <button onClick={handleMasterSwitch} disabled={confirmInput !== actionType} className={`flex-1 py-2 rounded-lg text-sm font-bold text-white transition-all disabled:opacity-50 ${actionType === 'DISABLE' ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'}`}>Confirm</button>
                        </div>
                    </div>
                </div>
            </div>
        )}
        </>
    );
};
