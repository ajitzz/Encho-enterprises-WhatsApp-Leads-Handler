
import React from 'react';
import { Database, Zap, MessageCircle, AlertTriangle, CheckCircle, Clock, ServerOff, Server, Activity, ShieldCheck, Flame, Gauge } from 'lucide-react';
import { SystemHealth } from '../types';

interface SystemStatusBannerProps {
    health: SystemHealth | null;
    isLoading: boolean;
}

export const SystemStatusBanner: React.FC<SystemStatusBannerProps> = ({ health, isLoading }) => {
    if (!health && isLoading) return (
        <div className="animate-pulse flex gap-4 mb-8">
            <div className="h-24 bg-gray-200 rounded-2xl flex-1"></div>
            <div className="h-24 bg-gray-200 rounded-2xl flex-1"></div>
            <div className="h-24 bg-gray-200 rounded-2xl flex-1"></div>
        </div>
    );

    if (!health) return null;

    // --- AI STATUS LOGIC ---
    const isPro = health.ai.activeModel?.includes('pro');
    const isDegraded = health.ai.status === 'degraded' || health.ai.status === 'quota_exceeded';
    const isError = health.ai.status === 'error';

    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
            
            {/* 1. AI ENGINE CARD (Dynamic: Pro vs Flash) */}
            <div className={`relative overflow-hidden rounded-2xl p-6 shadow-sm border transition-all duration-300 group
                ${isError ? 'bg-red-50 border-red-200' : isDegraded ? 'bg-amber-50 border-amber-200' : 'bg-white border-purple-100'}
            `}>
                <div className="absolute top-0 right-0 p-3 opacity-10 group-hover:opacity-20 transition-opacity">
                    <Zap size={80} className={isDegraded ? 'text-amber-500' : 'text-purple-600'} />
                </div>
                
                <div className="relative z-10 flex flex-col h-full justify-between">
                    <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                            <div className={`p-2.5 rounded-xl ${isDegraded ? 'bg-amber-100 text-amber-600' : 'bg-purple-100 text-purple-600'}`}>
                                {isDegraded ? <Flame size={20} /> : <SparklesIcon />}
                            </div>
                            <div>
                                <h4 className="font-bold text-gray-900">AI Engine</h4>
                                <div className="flex items-center gap-1.5 mt-0.5">
                                    <span className={`w-1.5 h-1.5 rounded-full ${isError ? 'bg-red-500' : 'bg-green-500 animate-pulse'}`}></span>
                                    <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                                        {isPro ? 'GEMINI 3 PRO' : 'GEMINI 3 FLASH'}
                                    </span>
                                </div>
                            </div>
                        </div>
                        {isDegraded ? (
                            <span className="bg-amber-100 text-amber-700 text-[10px] font-bold px-2 py-1 rounded-full border border-amber-200 flex items-center gap-1">
                                <Gauge size={10} /> FALLBACK ACTIVE
                            </span>
                        ) : (
                            <span className="bg-purple-50 text-purple-700 text-[10px] font-bold px-2 py-1 rounded-full border border-purple-100 flex items-center gap-1">
                                <Zap size={10} /> SMART SCALE
                            </span>
                        )}
                    </div>

                    <div className="mt-4">
                        <p className={`text-sm font-medium ${isDegraded ? 'text-amber-800' : 'text-gray-600'}`}>
                            {health.ai.message || "Operational"}
                        </p>
                        {isDegraded && (
                           <div className="mt-2 text-xs text-amber-600 flex items-center gap-1 bg-amber-100/50 p-1.5 rounded-lg border border-amber-200/50">
                               <Clock size={12} />
                               <span>Auto-recovering to PRO in ~60s</span>
                           </div>
                        )}
                        {!isDegraded && isPro && (
                           <div className="mt-2 text-xs text-purple-600 flex items-center gap-1 opacity-70">
                               <CheckCircle size={12} />
                               <span>Running on High Performance Model</span>
                           </div>
                        )}
                    </div>
                </div>
            </div>

            {/* 2. DATABASE CARD */}
            <div className={`relative overflow-hidden rounded-2xl p-6 shadow-sm border bg-white border-gray-200 group`}>
                <div className="absolute top-0 right-0 p-3 opacity-5 group-hover:opacity-10 transition-opacity">
                    <Database size={80} />
                </div>
                
                <div className="relative z-10 flex flex-col h-full justify-between">
                    <div className="flex items-start gap-3">
                         <div className={`p-2.5 rounded-xl ${health.database.status === 'connected' ? 'bg-blue-50 text-blue-600' : 'bg-red-50 text-red-600'}`}>
                            <Server size={20} />
                         </div>
                         <div>
                             <h4 className="font-bold text-gray-900">Database</h4>
                             <div className="flex items-center gap-1.5 mt-0.5">
                                 <span className={`w-1.5 h-1.5 rounded-full ${health.database.status === 'connected' ? 'bg-green-500' : 'bg-red-500'}`}></span>
                                 <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">NEON POSTGRES</span>
                             </div>
                         </div>
                    </div>
                    
                    <div className="mt-4">
                        {health.database.status === 'connected' ? (
                             <div className="flex items-center gap-4">
                                 <div className="flex flex-col">
                                     <span className="text-[10px] text-gray-400 uppercase font-bold">Latency</span>
                                     <span className="text-sm font-mono text-gray-700">{health.database.latency}ms</span>
                                 </div>
                                 <div className="flex flex-col">
                                     <span className="text-[10px] text-gray-400 uppercase font-bold">Pool</span>
                                     <span className="text-sm font-mono text-gray-700">Active</span>
                                 </div>
                             </div>
                        ) : (
                             <p className="text-xs text-red-600 font-medium bg-red-50 p-2 rounded border border-red-100">
                                 Connection Failed. Check Vercel Env Vars.
                             </p>
                        )}
                    </div>
                </div>
            </div>

            {/* 3. WHATSAPP CARD */}
            <div className={`relative overflow-hidden rounded-2xl p-6 shadow-sm border bg-white border-gray-200 group`}>
                <div className="absolute top-0 right-0 p-3 opacity-5 group-hover:opacity-10 transition-opacity">
                    <MessageCircle size={80} />
                </div>

                <div className="relative z-10 flex flex-col h-full justify-between">
                    <div className="flex items-start gap-3">
                         <div className={`p-2.5 rounded-xl ${health.whatsapp.status === 'active' ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-500'}`}>
                            <Activity size={20} />
                         </div>
                         <div>
                             <h4 className="font-bold text-gray-900">WhatsApp API</h4>
                             <div className="flex items-center gap-1.5 mt-0.5">
                                 <span className={`w-1.5 h-1.5 rounded-full ${health.whatsapp.status === 'active' ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`}></span>
                                 <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">META CLOUD</span>
                             </div>
                         </div>
                    </div>

                    <div className="mt-4">
                        {health.whatsapp.status === 'active' ? (
                            <p className="text-sm text-gray-600 flex items-center gap-2">
                                <ShieldCheck size={16} className="text-green-500" />
                                <span>Webhook Connected</span>
                            </p>
                        ) : health.whatsapp.status === 'waiting_for_webhook' ? (
                            <div className="bg-blue-50 border border-blue-100 rounded-lg p-2">
                                <p className="text-xs text-blue-700">Waiting for first message...</p>
                            </div>
                        ) : (
                            <div className="bg-gray-100 border border-gray-200 rounded-lg p-2">
                                <p className="text-xs text-gray-500">API Token Missing in Settings</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

// Simple Sparkle Icon Component
const SparklesIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 2L14.4 9.6L22 12L14.4 14.4L12 22L9.6 14.4L2 12L9.6 9.6L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
);
