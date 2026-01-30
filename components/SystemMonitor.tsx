
import React, { useEffect, useState, useRef } from 'react';
import { Database, Server, Shield, X, AlertTriangle, Zap, RefreshCw, AlertCircle, DatabaseZap, Workflow } from 'lucide-react';
import { SystemStats } from '../types';

interface DiagnosticStats extends SystemStats {
    dbStatus?: 'connected' | 'error' | 'unknown';
    redisStatus?: 'connected' | 'error' | 'unknown';
    tables?: { candidates: boolean; bot_versions: boolean };
    counts?: { candidates: number };
    lastError?: string;
    workerUrl?: string;
    env?: { hasPostgres: boolean; hasRedis: boolean; hasQStash: boolean; publicUrl: string };
}

export const SystemMonitor = () => {
    const [stats, setStats] = useState<DiagnosticStats | null>(null);
    const [isOpen, setIsOpen] = useState(false);
    const [showControls, setShowControls] = useState(false);
    const [dbActionStatus, setDbActionStatus] = useState('');
    const timerRef = useRef<any>(null);

    useEffect(() => {
        startPolling();
        return () => clearTimeout(timerRef.current);
    }, []);

    const startPolling = async () => {
        const poll = async () => {
            try {
                const response = await fetch('/api/debug/status', {
                   headers: { 'Authorization': `Bearer ${localStorage.getItem('uber_fleet_auth_token')}` }
                });
                if (response.ok) {
                    const debugStats = await response.json();
                    setStats({
                        serverLoad: 0, dbLatency: 0, aiCredits: 0, aiModel: 'unknown', s3Status: 'ok', s3Load: 0, whatsappStatus: 'ok', whatsappUploadLoad: 0, activeUploads: 0, uptime: 0,
                        dbStatus: debugStats.postgres,
                        redisStatus: debugStats.redis,
                        tables: debugStats.tables,
                        counts: debugStats.counts,
                        lastError: debugStats.lastError,
                        workerUrl: debugStats.workerUrl,
                        env: debugStats.env
                    });
                }
            } catch(e) {}
            timerRef.current = setTimeout(poll, 5000); 
        };
        poll();
    };

    const handleInitDB = async () => {
        setDbActionStatus('Creating Tables...');
        try {
            await fetch('/api/system/init-db', { method: 'POST', headers: { 'Authorization': `Bearer ${localStorage.getItem('uber_fleet_auth_token')}` } });
            setDbActionStatus('Tables Ready!');
            const res = await fetch('/api/debug/status', { headers: { 'Authorization': `Bearer ${localStorage.getItem('uber_fleet_auth_token')}` }});
            if(res.ok) { const d = await res.json(); setStats(prev => ({...prev!, tables: d.tables, counts: d.counts})); }
        } catch(e) { setDbActionStatus('Failed'); }
    };

    const handleSeedDB = async () => {
        setDbActionStatus('Seeding Data...');
        try {
            await fetch('/api/system/seed-db', { method: 'POST', headers: { 'Authorization': `Bearer ${localStorage.getItem('uber_fleet_auth_token')}` } });
            setDbActionStatus('Seeded! Reloading...');
            setTimeout(() => window.location.reload(), 1000);
        } catch(e) { setDbActionStatus('Failed'); }
    };

    if (!stats) return null;

    const isDbError = stats.dbStatus === 'error';
    const isTablesMissing = stats.dbStatus === 'connected' && (!stats.tables?.candidates || !stats.tables?.bot_versions);
    const isDbEmpty = stats.dbStatus === 'connected' && !isTablesMissing && (stats.counts?.candidates === 0);
    const hasCriticalIssue = isDbError || isTablesMissing || isDbEmpty;
    const isWorkerLocalhost = stats.workerUrl && stats.workerUrl.includes('localhost') && !window.location.hostname.includes('localhost');

    return (
        <>
        <div className={`fixed bottom-0 left-0 right-0 z-40 transition-transform duration-300 ${isOpen ? 'translate-y-0' : 'translate-y-[calc(100%-4px)]'}`}>
            <div 
                className={`h-1 cursor-pointer hover:h-2 transition-all ${hasCriticalIssue || isWorkerLocalhost ? 'bg-red-500 animate-pulse' : 'bg-gradient-to-r from-green-500 via-blue-500 to-purple-500'}`}
                onClick={() => setIsOpen(!isOpen)}
                title="System Monitor"
            />
            
            <div className="bg-black/90 backdrop-blur-md text-white border-t border-gray-800 p-2 flex items-center justify-between text-[10px] font-mono shadow-2xl">
                <div className="flex items-center gap-4 px-2">
                    <div className="flex items-center gap-1.5">
                        <Database size={12} className={stats.dbStatus === 'connected' ? 'text-blue-400' : 'text-red-500 animate-pulse'} />
                        <span className="text-gray-400">DB:</span>
                        <span className={`font-bold ${stats.dbStatus === 'connected' ? 'text-white' : 'text-red-400'}`}>{stats.dbStatus === 'connected' ? 'OK' : 'ERR'}</span>
                    </div>
                    {stats.dbStatus === 'connected' && (
                        <div className="flex items-center gap-1.5">
                            <span className="text-gray-400">SCHEMA:</span>
                            <span className={`font-bold ${!isTablesMissing ? 'text-green-400' : 'text-red-400'}`}>{!isTablesMissing ? 'VALID' : 'MISSING'}</span>
                        </div>
                    )}
                    {stats.workerUrl && (
                        <div className="flex items-center gap-1.5 hidden md:flex">
                             <span className="text-gray-400">WORKER:</span>
                             <span className={`truncate max-w-[150px] ${isWorkerLocalhost ? 'text-red-400' : 'text-gray-300'}`}>{stats.workerUrl}</span>
                        </div>
                    )}
                </div>

                {(hasCriticalIssue || isWorkerLocalhost) && (
                    <div className="absolute left-1/2 transform -translate-x-1/2 top-1 flex items-center gap-2 bg-red-600/90 px-3 py-1 rounded text-white font-bold animate-pulse cursor-pointer" onClick={() => setShowControls(true)}>
                        <AlertTriangle size={12} />
                        {isDbError ? 'DB ERROR' : isTablesMissing ? 'MISSING TABLES' : isWorkerLocalhost ? 'INVALID WORKER URL' : 'DATABASE EMPTY'}
                        <span className="underline">FIX</span>
                    </div>
                )}

                <div className="flex items-center gap-2">
                     <button onClick={() => setShowControls(true)} className="hover:text-white text-gray-400 flex items-center gap-1"><Shield size={12} /> Diagnose</button>
                </div>
            </div>
        </div>

        {showControls && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
                <div className="bg-gray-900 rounded-xl shadow-2xl w-full max-w-lg border border-gray-700 animate-in zoom-in-95">
                    <div className="p-5 border-b border-gray-800 flex items-center justify-between">
                        <h3 className="font-bold text-white flex items-center gap-2"><DatabaseZap size={20} className="text-blue-500" /> System Diagnostics</h3>
                        <button onClick={() => setShowControls(false)} className="text-gray-400 hover:text-white"><X size={20} /></button>
                    </div>
                    
                    <div className="p-6 space-y-6">
                        {isWorkerLocalhost && (
                             <div className="bg-red-900/30 border border-red-800 p-4 rounded-lg">
                                <div className="flex items-center gap-2 text-red-400 font-bold mb-2"><AlertCircle size={18} /> Critical Config Error</div>
                                <p className="text-xs text-gray-300 mb-2">QStash is trying to hit <strong>localhost</strong>. This will fail in production.</p>
                                <div className="text-xs bg-black/50 p-2 rounded text-gray-400 font-mono break-all">{stats.workerUrl}</div>
                                <p className="text-xs text-gray-400 mt-2">Add <strong>PUBLIC_BASE_URL</strong> to Vercel Env Variables.</p>
                            </div>
                        )}

                        {isDbError && (
                            <div className="bg-red-900/30 border border-red-800 p-4 rounded-lg">
                                <div className="flex items-center gap-2 text-red-400 font-bold mb-2"><AlertCircle size={18} /> Connection Failed</div>
                                <p className="text-xs text-gray-300 mb-2">Postgres Error: <span className="font-mono text-red-300">{stats.lastError || 'Unknown'}</span></p>
                            </div>
                        )}

                        {isTablesMissing && (
                            <div className="bg-amber-900/30 border border-amber-800 p-4 rounded-lg">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2 text-amber-400 font-bold"><AlertTriangle size={18} /> Tables Missing</div>
                                    {dbActionStatus && <span className="text-xs text-green-400">{dbActionStatus}</span>}
                                </div>
                                <button onClick={handleInitDB} className="w-full bg-amber-600 hover:bg-amber-700 text-white font-bold py-2 rounded text-xs flex items-center justify-center gap-2"><DatabaseZap size={14} /> Initialize Database Schema</button>
                            </div>
                        )}

                        {isDbEmpty && (
                            <div className="bg-blue-900/30 border border-blue-800 p-4 rounded-lg">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2 text-blue-400 font-bold"><Database size={18} /> Database Empty</div>
                                    {dbActionStatus && <span className="text-xs text-green-400">{dbActionStatus}</span>}
                                </div>
                                <button onClick={handleSeedDB} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 rounded text-xs flex items-center justify-center gap-2"><RefreshCw size={14} /> Seed Dummy Data</button>
                            </div>
                        )}

                        <div className="grid grid-cols-2 gap-4 text-xs font-mono text-gray-500">
                             <div className="bg-gray-800 p-2 rounded border border-gray-700">PG: {stats.env?.hasPostgres ? 'OK' : 'MISSING'}</div>
                             <div className="bg-gray-800 p-2 rounded border border-gray-700">Redis: {stats.env?.hasRedis ? 'OK' : 'MISSING'}</div>
                             <div className="bg-gray-800 p-2 rounded border border-gray-700">QStash: {stats.env?.hasQStash ? 'OK' : 'MISSING'}</div>
                             <div className="bg-gray-800 p-2 rounded border border-gray-700 truncate" title={stats.env?.publicUrl}>Public URL: {stats.env?.publicUrl}</div>
                        </div>
                    </div>
                </div>
            </div>
        )}
        </>
    );
};
