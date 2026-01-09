
import React, { useEffect, useState } from 'react';
import { liveApiService } from '../services/liveApiService';
import { Activity, Database, Brain, Cloud, Wifi, ArrowUpCircle, Clock, UploadCloud, MessageSquare } from 'lucide-react';
import { SystemStats } from '../types';

export const SystemMonitor = () => {
    const [stats, setStats] = useState<SystemStats | null>(null);
    const [isOpen, setIsOpen] = useState(false);

    useEffect(() => {
        const fetchStats = async () => {
            try {
                const response = await fetch('/api/system/stats');
                if (response.ok) {
                    setStats(await response.json());
                }
            } catch(e) {}
        };
        fetchStats();
        const interval = setInterval(fetchStats, 5000);
        return () => clearInterval(interval);
    }, []);

    const formatUptime = (seconds: number) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return `${h}h ${m}m`;
    };

    if (!stats) return null;

    return (
        <div className={`fixed bottom-0 left-0 right-0 z-40 transition-transform duration-300 ${isOpen ? 'translate-y-0' : 'translate-y-[calc(100%-4px)]'}`}>
            {/* Minimal Strip (Always Visible) */}
            <div 
                className="h-1 bg-gradient-to-r from-green-500 via-blue-500 to-purple-500 cursor-pointer hover:h-2 transition-all"
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
                    
                    {stats.uptime !== undefined && (
                        <div className="flex items-center gap-1.5 text-gray-500" title="Server Uptime">
                            <Clock size={12} />
                            <span>{formatUptime(stats.uptime)}</span>
                        </div>
                    )}
                    
                    <button onClick={() => setIsOpen(false)} className="text-gray-500 hover:text-white ml-2">
                        <ArrowUpCircle size={14} className="rotate-180" />
                    </button>
                </div>
            </div>
        </div>
    );
};
