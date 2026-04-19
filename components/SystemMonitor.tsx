
import React, { useEffect, useState, useRef } from 'react';
import { Database, Shield, X, AlertTriangle, RefreshCw, DatabaseZap, Trash2, Hammer, Gauge } from 'lucide-react';
import { SystemStats } from '../types';
import { reportUiFailure, reportUiRecovery } from '../services/uiFailureMonitor';

interface DiagnosticStats extends SystemStats {
    dbStatus?: 'connected' | 'error' | 'unknown';
    tables?: { candidates: boolean; bot_versions: boolean };
    counts?: { candidates: number };
    lastError?: string;
    env?: { hasPostgres: boolean; publicUrl: string };
}

interface TransferBudgetStats {
    projections: {
        totalGb: number;
        headroomGb: number;
        utilizationPct: number;
        grade: string;
        breakdownGb: {
            message: number;
            mediaMetadata: number;
            healthChecks: number;
            webhookVerify: number;
        };
    };
    assumptions: {
        leadsPerWeek: number;
        messagesPerLead: number;
        cacheHitRatio: number;
        writeBatchSize: number;
        budgetGb: number;
    };
    monitored: {
        source: 'manual_env' | 'projection_fallback';
        usedGb: number;
        remainingGb: number;
        utilizationPct: number;
        severity: 'normal' | 'warning' | 'elevated' | 'incident';
        notes: string;
    };
    thresholds: {
        warningPct: number;
        elevatedPct: number;
        incidentPct: number;
    };
}

export const SystemMonitor = () => {
    const [stats, setStats] = useState<DiagnosticStats | null>(null);
    const [transferStats, setTransferStats] = useState<TransferBudgetStats | null>(null);
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
                    reportUiRecovery('polling', '/api/debug/status');
                    const debugStats = await response.json();
                    setStats({
                        serverLoad: 0, dbLatency: 0, aiCredits: 0, aiModel: 'unknown', s3Status: 'ok', s3Load: 0, whatsappStatus: 'ok', whatsappUploadLoad: 0, activeUploads: 0, uptime: 0,
                        dbStatus: debugStats.postgres,
                        tables: debugStats.tables,
                        counts: debugStats.counts,
                        lastError: debugStats.lastError,
                        env: debugStats.env
                    });
                }

                const transferResponse = await fetch('/api/system/transfer-budget', {
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('uber_fleet_auth_token')}` }
                });
                if (transferResponse.ok) {
                    const transferPayload = await transferResponse.json();
                    setTransferStats({
                        projections: transferPayload.projections,
                        assumptions: transferPayload.assumptions,
                        monitored: transferPayload.monitored,
                        thresholds: transferPayload.thresholds,
                    });
                }
            } catch(e) {
                reportUiFailure({
                    channel: 'polling',
                    endpoint: '/api/debug/status',
                    error: e,
                    notifyAdmin: (message) => console.warn('[admin.notify]', message)
                });
            }
            timerRef.current = setTimeout(poll, 60000);
        };
        poll();
    };

    const handleInitDB = async () => {
        setDbActionStatus('Creating Tables...');
        try {
            await fetch('/api/system/init-db', { method: 'POST', headers: { 'Authorization': `Bearer ${localStorage.getItem('uber_fleet_auth_token')}` } });
            setDbActionStatus('Tables Ready! Reloading...');
            setTimeout(() => window.location.reload(), 2000);
        } catch(e) { setDbActionStatus('Failed'); }
    };

    const handleHardReset = async () => {
        if(!window.confirm("CRITICAL WARNING:\n\nThis will DELETE ALL DATA (Messages, Leads, Settings) and recreate the database tables.\n\nUse this only if you see '500 Internal Server Errors' continuously.\n\nAre you sure?")) return;
        
        setDbActionStatus('Resetting & Rebuilding...');
        try {
            const res = await fetch('/api/system/hard-reset', { method: 'POST', headers: { 'Authorization': `Bearer ${localStorage.getItem('uber_fleet_auth_token')}` } });
            if (!res.ok) throw new Error("Reset Request Failed");
            
            setDbActionStatus('Rebuild Complete. Reloading...');
            setTimeout(() => window.location.reload(), 2000);
        } catch(e) { setDbActionStatus('Reset Failed: Check Console'); console.error(e); }
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

    return (
        <>
        <div className={`fixed bottom-0 left-0 right-0 z-40 transition-transform duration-300 ${isOpen ? 'translate-y-0' : 'translate-y-[calc(100%-4px)]'}`}>
            <div 
                className={`h-1 cursor-pointer hover:h-2 transition-all ${hasCriticalIssue ? 'bg-red-500 animate-pulse' : 'bg-gradient-to-r from-green-500 via-blue-500 to-purple-500'}`}
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
                </div>

                {hasCriticalIssue && (
                    <div className="absolute left-1/2 transform -translate-x-1/2 top-1 flex items-center gap-2 bg-red-600/90 px-3 py-1 rounded text-white font-bold animate-pulse cursor-pointer" onClick={() => setShowControls(true)}>
                        <AlertTriangle size={12} />
                        {isDbError ? 'DB ERROR' : isTablesMissing ? 'MISSING TABLES' : 'DATABASE EMPTY'}
                        <span className="underline">FIX</span>
                    </div>
                )}

                <div className="flex items-center gap-2">
                     {transferStats && (
                        <div className="flex items-center gap-1.5">
                            <Gauge size={12} className={`${transferStats.projections.utilizationPct > transferStats.thresholds.warningPct ? 'text-amber-400' : 'text-green-400'}`} />
                            <span className="text-gray-400">XFER:</span>
                            <span className={`font-bold ${transferStats.monitored.utilizationPct > transferStats.thresholds.warningPct ? 'text-amber-400' : 'text-green-400'}`}>
                                {transferStats.monitored.utilizationPct.toFixed(1)}%
                            </span>
                        </div>
                     )}
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
                        {/* REPAIR SCHEMA BUTTON FOR MISSING TABLES */}
                        {isTablesMissing && (
                            <div className="bg-red-900/30 border border-red-800 p-4 rounded-lg">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2 text-red-400 font-bold"><AlertTriangle size={18} /> Tables Missing</div>
                                    {dbActionStatus && <span className="text-xs text-green-400">{dbActionStatus}</span>}
                                </div>
                                <p className="text-xs text-gray-400 mb-3">Database connected but tables not found. Click below to recreate them safely.</p>
                                <button onClick={handleInitDB} className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-2 rounded text-xs flex items-center justify-center gap-2">
                                    <Hammer size={14} /> REPAIR SCHEMA
                                </button>
                            </div>
                        )}

                        <div className="bg-amber-900/30 border border-amber-800 p-4 rounded-lg">
                            <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2 text-amber-400 font-bold"><AlertTriangle size={18} /> Factory Reset Database</div>
                                {dbActionStatus && <span className="text-xs text-green-400">{dbActionStatus}</span>}
                            </div>
                            <p className="text-xs text-gray-400 mb-3">
                                <strong>Warning:</strong> This will drop all tables and recreate them from scratch. Use this if the "MISSING TABLES" error persists.
                            </p>
                            <button onClick={handleHardReset} className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-2 rounded text-xs flex items-center justify-center gap-2">
                                <Trash2 size={14} /> WIPE & REBUILD TABLES
                            </button>
                        </div>

                        {isDbEmpty && !isTablesMissing && (
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
                             <div className="bg-gray-800 p-2 rounded border border-gray-700 truncate" title={stats.env?.publicUrl}>Public URL: {stats.env?.publicUrl}</div>
                        </div>

                        {transferStats && (
                            <div className="bg-emerald-900/20 border border-emerald-800 p-4 rounded-lg text-xs">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2 text-emerald-400 font-bold"><Gauge size={16} /> DB Transfer Budget</div>
                                    <span className="text-emerald-300">{transferStats.projections.grade}</span>
                                </div>
                                <div className="grid grid-cols-2 gap-2 text-gray-300 font-mono">
                                    <div className="bg-gray-800 p-2 rounded border border-gray-700">Used: {transferStats.monitored.usedGb.toFixed(3)} GB</div>
                                    <div className="bg-gray-800 p-2 rounded border border-gray-700">Headroom: {transferStats.monitored.remainingGb.toFixed(3)} GB</div>
                                    <div className="bg-gray-800 p-2 rounded border border-gray-700">Utilization: {transferStats.monitored.utilizationPct.toFixed(2)}%</div>
                                    <div className="bg-gray-800 p-2 rounded border border-gray-700">Budget: {transferStats.assumptions.budgetGb.toFixed(1)} GB</div>
                                </div>
                                <div className="mt-3 text-gray-400 space-y-1">
                                    <div>Source: {transferStats.monitored.source === 'manual_env' ? 'Provider usage (env)' : 'Estimator projection'} • State: {transferStats.monitored.severity.toUpperCase()}</div>
                                    <div>{transferStats.monitored.notes}</div>
                                    <div>Message: {transferStats.projections.breakdownGb.message.toFixed(3)} GB • Media Metadata: {transferStats.projections.breakdownGb.mediaMetadata.toFixed(3)} GB</div>
                                    <div>Health: {transferStats.projections.breakdownGb.healthChecks.toFixed(3)} GB • Webhook Verify: {transferStats.projections.breakdownGb.webhookVerify.toFixed(3)} GB</div>
                                    <div>Inputs: {transferStats.assumptions.leadsPerWeek}/wk, {transferStats.assumptions.messagesPerLead} msg/lead, cache {(transferStats.assumptions.cacheHitRatio * 100).toFixed(0)}%, batch {transferStats.assumptions.writeBatchSize.toFixed(0)}</div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        )}
        </>
    );
};
