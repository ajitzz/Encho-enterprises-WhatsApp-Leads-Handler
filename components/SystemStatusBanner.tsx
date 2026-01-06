
import React from 'react';
import { Database, Zap, MessageCircle, AlertTriangle, CheckCircle, Clock, ServerOff } from 'lucide-react';
import { SystemHealth } from '../types';

interface SystemStatusBannerProps {
    health: SystemHealth | null;
    isLoading: boolean;
}

export const SystemStatusBanner: React.FC<SystemStatusBannerProps> = ({ health, isLoading }) => {
    if (!health && isLoading) return (
        <div className="animate-pulse flex gap-4 mb-8">
            <div className="h-20 bg-gray-200 rounded-xl flex-1"></div>
            <div className="h-20 bg-gray-200 rounded-xl flex-1"></div>
            <div className="h-20 bg-gray-200 rounded-xl flex-1"></div>
        </div>
    );

    if (!health) return null;

    // Helper for Status Styles
    const getStatusStyle = (status: string, type: 'ai' | 'db' | 'wa') => {
        if (type === 'ai') {
            if (status === 'operational') return { bg: 'bg-gradient-to-br from-purple-500 to-indigo-600', icon: <Zap size={18} className="text-white" />, text: 'text-white', sub: 'text-purple-100', label: 'AI Operational' };
            if (status === 'quota_exceeded') return { bg: 'bg-gradient-to-br from-amber-500 to-orange-600', icon: <Clock size={18} className="text-white" />, text: 'text-white', sub: 'text-amber-100', label: 'Quota Limit Exceeded' };
            return { bg: 'bg-red-500', icon: <ServerOff size={18} className="text-white" />, text: 'text-white', sub: 'text-red-100', label: 'AI Error' };
        }
        if (type === 'db') {
            if (status === 'connected') return { bg: 'bg-white border border-gray-200', icon: <Database size={18} className="text-emerald-500" />, text: 'text-gray-900', sub: 'text-gray-500', label: 'Database Active' };
            return { bg: 'bg-red-50 border border-red-200', icon: <AlertTriangle size={18} className="text-red-500" />, text: 'text-red-800', sub: 'text-red-600', label: 'Database Error' };
        }
        if (type === 'wa') {
            if (status === 'active') return { bg: 'bg-white border border-gray-200', icon: <MessageCircle size={18} className="text-green-500" />, text: 'text-gray-900', sub: 'text-gray-500', label: 'WhatsApp Live' };
            if (status === 'waiting_for_webhook') return { bg: 'bg-blue-50 border border-blue-200', icon: <Clock size={18} className="text-blue-500" />, text: 'text-blue-900', sub: 'text-blue-600', label: 'Waiting for Webhook' };
            return { bg: 'bg-gray-50 border border-gray-200', icon: <AlertTriangle size={18} className="text-gray-400" />, text: 'text-gray-500', sub: 'text-gray-400', label: 'WhatsApp Not Configured' };
        }
        return { bg: 'bg-gray-100', icon: null, text: '', sub: '', label: '' };
    };

    const aiStyle = getStatusStyle(health.ai.status, 'ai');
    const dbStyle = getStatusStyle(health.database.status, 'db');
    const waStyle = getStatusStyle(health.whatsapp.status, 'wa');

    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
            {/* AI CARD (Hero) */}
            <div className={`relative overflow-hidden rounded-xl p-5 shadow-sm transition-all ${aiStyle.bg}`}>
                <div className="relative z-10 flex flex-col h-full justify-between">
                    <div className="flex items-center justify-between mb-2">
                         <div className="bg-white/20 p-2 rounded-lg backdrop-blur-sm">{aiStyle.icon}</div>
                         {health.ai.status === 'quota_exceeded' && (
                             <span className="text-[10px] font-bold bg-white/20 px-2 py-1 rounded text-white backdrop-blur-sm animate-pulse">
                                 RETRYING SOON
                             </span>
                         )}
                    </div>
                    <div>
                        <h4 className={`font-bold text-lg ${aiStyle.text}`}>{aiStyle.label}</h4>
                        <p className={`text-xs mt-1 ${aiStyle.sub}`}>
                            {health.ai.status === 'quota_exceeded' 
                                ? "System has paused AI to recover credits." 
                                : health.ai.message || "Gemini 1.5 Flash Ready"}
                        </p>
                    </div>
                </div>
                {/* Decor */}
                <div className="absolute -right-4 -bottom-4 w-24 h-24 bg-white/10 rounded-full blur-2xl"></div>
            </div>

            {/* DB CARD */}
            <div className={`rounded-xl p-5 shadow-sm transition-all flex items-center gap-4 ${dbStyle.bg}`}>
                <div className="bg-gray-50 p-3 rounded-xl border border-gray-100">
                    {dbStyle.icon}
                </div>
                <div>
                    <h4 className={`font-bold text-sm ${dbStyle.text}`}>{dbStyle.label}</h4>
                    <p className={`text-xs ${dbStyle.sub}`}>
                        {health.database.status === 'connected' 
                            ? `Latency: ${health.database.latency}ms` 
                            : "Check connection string in Vercel."}
                    </p>
                </div>
            </div>

            {/* WHATSAPP CARD */}
            <div className={`rounded-xl p-5 shadow-sm transition-all flex items-center gap-4 ${waStyle.bg}`}>
                <div className="bg-gray-50 p-3 rounded-xl border border-gray-100">
                    {waStyle.icon}
                </div>
                <div>
                    <h4 className={`font-bold text-sm ${waStyle.text}`}>{waStyle.label}</h4>
                    <p className={`text-xs ${waStyle.sub}`}>
                        {health.whatsapp.status === 'active' 
                            ? "Receiving messages in real-time."
                            : health.whatsapp.status === 'waiting_for_webhook' 
                                ? "Configured. Send a test message to activate." 
                                : "API Token missing in server.js"}
                    </p>
                </div>
            </div>
        </div>
    );
};
