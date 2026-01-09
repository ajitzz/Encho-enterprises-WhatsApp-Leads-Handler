
import React, { useEffect, useState } from 'react';
import { liveApiService } from '../services/liveApiService';
import { Activity, Database, Brain, Cloud, Wifi, ArrowUpCircle, Clock } from 'lucide-react';
import { SystemStats } from '../types';

interface ExtendedSystemStats extends SystemStats {
    uptime?: number;
}

export const SystemMonitor = () => {
    const [stats, setStats] = useState<ExtendedSystemStats | null>(null);
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
            <div className="bg-black/90 backdrop-blur-md text-white border-t border-gray-800 p-2 flex items-center justify-between text-xs font-mono shadow-2xl">
                <div className="flex items-center gap-6 px-4">
                    <div className="flex items-center gap-2" title="Server CPU Load">
                        <Activity size={14} className={stats.serverLoad > 80 ? 'text-red-500' : 'text-green-400'} />
                        <span className="text-gray-400">SRV:</span>
                        <span className="font-bold">{stats.serverLoad}%</span>
                    </div>

                    <div className="flex items-center gap-2" title="DB Latency">
                        <Database size={14} className={stats.dbLatency > 500 ? 'text-amber-500' : 'text-blue-400'} />
                        <span className="text-gray-400">DB:</span>
                        <span className="font-bold">{stats.dbLatency}ms</span>
                    </div>

                    <div className="flex items-center gap-2" title="Active AI Model & Credits">
                        <Brain size={14} className="text-purple-400" />
                        <span className="text-gray-400">AI:</span>
                        <span className="font-bold">{stats.aiModel.split('-')[1]}</span>
                        <div className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden ml-1">
                            <div 
                                className="h-full bg-purple-500 transition-all duration-500" 
                                style={{ width: `${stats.aiCredits}%` }}
                            />
                        </div>
                    </div>
                </div>

                <div className="flex items-center gap-6 px-4 border-l border-gray-700">
                    {stats.uptime && (
                        <div className="flex items-center gap-2 text-green-400" title="Server Uptime">
                            <Clock size={14} />
                            <span>{formatUptime(stats.uptime)}</span>
                        </div>
                    )}

                    <div className="flex items-center gap-2" title="Active Media Uploads">
                         <Cloud size={14} className={stats.activeUploads > 0 ? 'text-blue-400 animate-pulse' : 'text-gray-500'} />
                         <span className="text-gray-400">UP:</span>
                         <span>{stats.activeUploads}</span>
                    </div>

                    <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${stats.s3Status === 'ok' ? 'bg-green-500' : 'bg-red-500'}`} />
                        <span className="text-gray-500">S3</span>
                    </div>

                    <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${stats.whatsappStatus === 'ok' ? 'bg-green-500' : 'bg-amber-500'}`} />
                        <span className="text-gray-500">WhatsApp</span>
                    </div>
                    
                    <button onClick={() => setIsOpen(false)} className="text-gray-500 hover:text-white">
                        <ArrowUpCircle size={14} className="rotate-180" />
                    </button>
                </div>
            </div>
        </div>
    );
};
