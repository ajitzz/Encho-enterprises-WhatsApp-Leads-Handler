
import React, { useEffect, useState, useRef } from 'react';
import { liveApiService } from '../services/liveApiService';
import { Activity, Database, Brain, Cloud, Wifi, ArrowUpCircle, Clock, UploadCloud, MessageSquare, Shield, X, Power, AlertTriangle, Play, Pause, Lock, Slash } from 'lucide-react';
import { SystemStats } from '../types';

export const SystemMonitor = () => {
    const [stats, setStats] = useState<SystemStats | null>(null);
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

    // Sequential Polling Ref
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
                const response = await fetch('/api/system/stats', {
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('uber_fleet_auth_token')}` }
                });
                
                if (response.status === 401 || response.status === 403) {
                    setAuthError(true);
                    return; // Stop polling on auth fail
                }

                if (response.ok) {
                    setStats(await response.json());
                    setAuthError(false);
                }
            } catch(e) {
                // Silent fail
            } finally {
                isFetching.current = false;
                // Schedule next poll only if no auth error
                if (!authError) {
                    timerRef.current = setTimeout(poll, 5000); 
                }
            }
        };
        poll();
    };

    const stopPolling = () => {
        if (timerRef.current) clearTimeout(timerRef.current);
    };

    // Load Settings when opening controls
    useEffect(() => {
        if (showControls) {
            loadSettings();
        }
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
        setSettings(newSettings); // Optimistic UI
        await liveApiService.updateSystemSettings(newSettings);
    };

    const handleMasterSwitch = async () => {
        if (actionType === 'DISABLE') {
            const newSettings = {
                ...settings,
                automation_enabled: false,
                sending_enabled: false
            };
            setSettings(newSettings);
            await liveApiService.updateSystemSettings(newSettings);
        } else {
            const newSettings = {
                ...settings,
                automation_enabled: true,
                sending_enabled: true
            };
            setSettings(newSettings);
            await liveApiService.updateSystemSettings(newSettings);
        }
        setShowConfirmModal(false);
        setConfirmInput('');
    };

    const openConfirmModal = (type: 'DISABLE' | 'ENABLE') => {
        setActionType(type);
        setConfirmInput('');
        setShowConfirmModal(true);
    };

    const formatUptime = (seconds: number) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return `${h}h ${m}m`;
    };

    if (authError) {
        return (
            <div className="fixed bottom-0 left-0 right-0 z-40 bg-red-900/90 backdrop-blur text-red-200 text-xs px-4 py-1 text-center font-bold">
                ⚠️ Monitor Disconnected: Authentication Failed
            </div>
        );
    }

    if (!stats) return null;

    return (
        <>
        <div className={`fixed bottom-0 left-0 right-0 z-40 transition-transform duration-300 ${isOpen ? 'translate-y-0' : 'translate-y-[calc(100%-4px)]'}`}>
            {/* Minimal Strip (Always Visible) */}
            <div 
                className={`h-1 cursor-pointer hover:h-2 transition-all ${(!settings.automation_enabled || !settings.sending_enabled) ? 'bg-red-500 animate-pulse' : 'bg-gradient-to-r from-green-500 via-blue-500 to-purple-500'}`}
                onClick={() => setIsOpen(!isOpen)}
                title="System Monitor"
            />
            
            {/* Detailed Dashboard */}
            <div className="bg-black/90 backdrop-blur-md text-white border-t border-gray-800 p-2 flex items-center justify-between text-[10px] font-mono shadow-2xl">
                <div className="flex items-center gap-4 px-2">
                    {/* Server Load */}
                    <div className="flex items-center gap-1.5" title="Server CPU Load">
                        <Activity size={12} className={stats.serverLoad > 80 ? 'text-red-500' : 'text-green-400'} />
                        <span className="text-gray-400">SRV:</span>
                        <span className="font-bold">{stats.serverLoad}%</span>
                    </div>

                    {/* DB Latency */}
                    <div className="flex items-center gap-1.5" title="DB Latency">
                        <Database size={12} className={stats.dbLatency > 500 ? 'text-amber-500' : 'text-blue-400'} />
                        <span className="text-gray-400">DB:</span>
                        <span className="font-bold">{stats.dbLatency}ms</span>
                    </div>

                    {/* AI Stats */}
                    <div className="flex items-center gap-1.5" title={`Active Model: ${stats.aiModel}`}>
                        <Brain size={12} className={stats.aiCredits < 20 ? 'text-red-400' : 'text-purple-400'} />
                        <span className="text-gray-400">AI:</span>
                        <span className="font-bold">{stats.aiModel.replace('Gemini ', '')}</span>
                        <span className={`px-1 rounded ${stats.aiCredits < 20 ? 'bg-red-900 text-red-200' : 'bg-purple-900 text-purple-200'}`}>
                            {stats.aiCredits}%
                        </span>
                    </div>
                </div>

                <div className="flex items-center gap-4 px-2 border-l border-gray-700">
                    {/* S3 Status & Load */}
                    <div className="flex items-center gap-1.5" title="S3 Storage & Transfer">
                         <Cloud size={12} className={stats.s3Load > 0 ? 'text-blue-400 animate-pulse' : 'text-gray-500'} />
                         <span className="text-gray-400">S3:</span>
                         <span className={stats.s3Status === 'ok' ? 'text-green-400' : 'text-red-400'}>{stats.s3Status}</span>
                         {stats.s3Load > 0 && <span className="text-blue-300">({stats.s3Load}%)</span>}
                    </div>

                    {/* WhatsApp API Status & Upload Load */}
                    <div className="flex items-center gap-1.5" title="WhatsApp Media Uploads">
                        <MessageSquare size={12} className={stats.whatsappUploadLoad > 0 ? 'text-green-400 animate-pulse' : 'text-gray-500'} />
                        <span className="text-gray-400">WA-API:</span>
                        <span className={stats.whatsappStatus === 'ok' ? 'text-green-400' : 'text-amber-400'}>{stats.whatsappStatus}</span>
                        {stats.whatsappUploadLoad > 0 && (
                            <div className="flex items-center gap-1 text-green-300">
                                <UploadCloud size={10} />
                                <span>{stats.whatsappUploadLoad}%</span>
                            </div>
                        )}
                    </div>
                    
                    {/* Automation Status Indicator */}
                    <div 
                        className={`flex items-center gap-1.5 px-2 py-0.5 rounded cursor-pointer transition-colors ${(!settings.automation_enabled || !settings.sending_enabled) ? 'bg-red-900/50 text-red-300' : 'hover:bg-gray-800 text-gray-400'}`}
                        onClick={() => setShowControls(true)}
                        title="Open Control Panel"
                    >
                        <Shield size={12} className={(!settings.automation_enabled || !settings.sending_enabled) ? 'text-red-500 animate-pulse' : 'text-green-500'} />
                        <span className="font-bold">CONTROLS</span>
                    </div>

                    <button onClick={() => setIsOpen(false)} className="text-gray-500 hover:text-white ml-2">
                        <ArrowUpCircle size={14} className="rotate-180" />
                    </button>
                </div>
            </div>
        </div>

        {/* AUTOMATION CONTROL PANEL MODAL */}
        {showControls && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
                <div className="bg-gray-900 rounded-xl shadow-2xl w-full max-w-lg border border-gray-700 animate-in zoom-in-95">
                    <div className="p-5 border-b border-gray-800 flex items-center justify-between">
                        <h3 className="font-bold text-white flex items-center gap-2">
                            <Shield size={20} className="text-blue-500" />
                            Automation Control Center
                        </h3>
                        <button onClick={() => setShowControls(false)} className="text-gray-400 hover:text-white"><X size={20} /></button>
                    </div>
                    
                    <div className="p-6 space-y-6">
                        {/* Status Grid */}
                        <div className="grid grid-cols-1 gap-4">
                            {/* Ingest Toggle */}
                            <div className="flex items-center justify-between bg-gray-800 p-4 rounded-lg border border-gray-700">
                                <div>
                                    <h4 className="text-white font-bold text-sm flex items-center gap-2">
                                        <UploadCloud size={16} /> Webhook Ingest
                                    </h4>
                                    <p className="text-gray-400 text-xs mt-1">Accept inbound messages from Meta.</p>
                                </div>
                                <div 
                                    onClick={() => toggleSetting('webhook_ingest_enabled')}
                                    className={`w-12 h-6 rounded-full p-1 cursor-pointer transition-colors ${settings.webhook_ingest_enabled ? 'bg-green-600' : 'bg-gray-600'}`}
                                >
                                    <div className={`w-4 h-4 bg-white rounded-full shadow-md transform transition-transform ${settings.webhook_ingest_enabled ? 'translate-x-6' : 'translate-x-0'}`} />
                                </div>
                            </div>

                            {/* Automation Toggle */}
                            <div className="flex items-center justify-between bg-gray-800 p-4 rounded-lg border border-gray-700">
                                <div>
                                    <h4 className="text-white font-bold text-sm flex items-center gap-2">
                                        <Brain size={16} /> Bot Automation
                                    </h4>
                                    <p className="text-gray-400 text-xs mt-1">Process messages and trigger bot replies.</p>
                                </div>
                                <div 
                                    onClick={() => toggleSetting('automation_enabled')}
                                    className={`w-12 h-6 rounded-full p-1 cursor-pointer transition-colors ${settings.automation_enabled ? 'bg-green-600' : 'bg-gray-600'}`}
                                >
                                    <div className={`w-4 h-4 bg-white rounded-full shadow-md transform transition-transform ${settings.automation_enabled ? 'translate-x-6' : 'translate-x-0'}`} />
                                </div>
                            </div>

                            {/* Sending Toggle */}
                            <div className="flex items-center justify-between bg-gray-800 p-4 rounded-lg border border-gray-700">
                                <div>
                                    <h4 className="text-white font-bold text-sm flex items-center gap-2">
                                        <MessageSquare size={16} /> Outbound Sending
                                    </h4>
                                    <p className="text-gray-400 text-xs mt-1">Allow API calls to send messages.</p>
                                </div>
                                <div 
                                    onClick={() => toggleSetting('sending_enabled')}
                                    className={`w-12 h-6 rounded-full p-1 cursor-pointer transition-colors ${settings.sending_enabled ? 'bg-green-600' : 'bg-gray-600'}`}
                                >
                                    <div className={`w-4 h-4 bg-white rounded-full shadow-md transform transition-transform ${settings.sending_enabled ? 'translate-x-6' : 'translate-x-0'}`} />
                                </div>
                            </div>
                        </div>

                        {/* Master Buttons */}
                        <div className="pt-4 border-t border-gray-800 grid grid-cols-2 gap-4">
                            <button 
                                onClick={() => openConfirmModal('ENABLE')}
                                className="bg-green-600 hover:bg-green-700 text-white py-3 rounded-lg font-bold text-sm flex items-center justify-center gap-2 shadow-lg transition-all"
                            >
                                <Play size={16} fill="currentColor" /> Resume All
                            </button>
                            <button 
                                onClick={() => openConfirmModal('DISABLE')}
                                className="bg-red-600 hover:bg-red-700 text-white py-3 rounded-lg font-bold text-sm flex items-center justify-center gap-2 shadow-lg transition-all animate-pulse"
                            >
                                <Power size={16} /> EMERGENCY STOP
                            </button>
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
                        <div className={`mx-auto w-12 h-12 rounded-full flex items-center justify-center mb-4 ${actionType === 'DISABLE' ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'}`}>
                            {actionType === 'DISABLE' ? <AlertTriangle size={24} /> : <Lock size={24} />}
                        </div>
                        <h3 className="text-lg font-bold text-gray-900 mb-2">
                            {actionType === 'DISABLE' ? 'Disable Automation?' : 'Enable Automation?'}
                        </h3>
                        <p className="text-sm text-gray-600 mb-6">
                            {actionType === 'DISABLE' 
                                ? 'This will stop the Bot Logic and block all Outbound Messages immediately. Inbound messages will still be saved.'
                                : 'This will reactivate Bot Logic and Outbound Sending. Queued messages may be sent immediately.'}
                        </p>
                        
                        <div className="mb-4">
                            <label className="block text-xs font-bold text-gray-500 uppercase mb-1">
                                Type <span className="font-mono text-black">{actionType}</span> to confirm
                            </label>
                            <input 
                                type="text" 
                                value={confirmInput}
                                onChange={(e) => setConfirmInput(e.target.value.toUpperCase())}
                                className="w-full border border-gray-300 rounded-lg p-2 text-center font-bold tracking-widest outline-none focus:ring-2 focus:ring-black"
                                autoFocus
                            />
                        </div>

                        <div className="flex gap-3">
                            <button 
                                onClick={() => setShowConfirmModal(false)}
                                className="flex-1 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50"
                            >
                                Cancel
                            </button>
                            <button 
                                onClick={handleMasterSwitch}
                                disabled={confirmInput !== actionType}
                                className={`flex-1 py-2 rounded-lg text-sm font-bold text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed ${actionType === 'DISABLE' ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'}`}
                            >
                                Confirm
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        )}
        </>
    );
};
