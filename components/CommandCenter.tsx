
import React, { useState, useEffect } from 'react';
import { 
  TrendingUp, 
  Users, 
  Loader2, 
  ArrowLeft,
  Activity
} from 'lucide-react';
import { liveApiService } from '../services/liveApiService.ts';

interface CommandCenterProps {
  managerId: string;
  onBack: () => void;
}

export const CommandCenter: React.FC<CommandCenterProps> = ({ managerId, onBack }) => {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const result = await liveApiService.getCommandCenter(managerId);
        setData(result);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [managerId]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <Loader2 className="animate-spin text-blue-600 mb-2" size={32} />
        <p className="text-sm text-gray-500 font-medium">Loading Command Center...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-center">
        <div className="bg-red-50 text-red-600 p-4 rounded-2xl border border-red-100">
          <p className="text-sm font-bold">Failed to load Command Center</p>
          <p className="text-xs mt-1">{error}</p>
        </div>
      </div>
    );
  }

  const { teamStats, conversionVelocity, distributionHeatmap } = data || { teamStats: [], conversionVelocity: [], distributionHeatmap: [] };

  const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
  const maxVelocity = Math.max(...conversionVelocity.map((entry: any) => entry.count), 1);
  const totalDistribution = distributionHeatmap.reduce((sum: number, entry: any) => sum + entry.count, 0);
  const pieStops = distributionHeatmap.reduce((acc: string[], entry: any, index: number) => {
    const previousPct = distributionHeatmap
      .slice(0, index)
      .reduce((sum: number, current: any) => sum + ((current.count / Math.max(totalDistribution, 1)) * 100), 0);
    const currentPct = previousPct + ((entry.count / Math.max(totalDistribution, 1)) * 100);
    acc.push(`${COLORS[index % COLORS.length]} ${previousPct}% ${currentPct}%`);
    return acc;
  }, []);
  const pieBackground = pieStops.length
    ? `conic-gradient(${pieStops.join(', ')})`
    : 'conic-gradient(#e5e7eb 0% 100%)';

  return (
    <div className="flex flex-col h-full bg-gray-50 animate-in slide-in-from-right duration-300">
      <div className="p-4 bg-white border-b border-gray-100 sticky top-0 z-10">
        <div className="flex items-center gap-3 mb-4">
          <button onClick={onBack} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
            <ArrowLeft size={20} />
          </button>
          <h2 className="text-lg font-bold">Command Center</h2>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Team Performance Overview */}
        <div className="space-y-3">
          <h3 className="text-xs font-bold text-gray-900 flex items-center gap-2 px-1">
            <Users size={14} className="text-blue-600" />
            Team Performance
          </h3>
          <div className="grid grid-cols-1 gap-3">
            {teamStats.map((staff: any, idx: number) => (
              <div key={staff.id} className="bg-white p-4 rounded-3xl border border-gray-100 shadow-sm flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gray-100 text-gray-600 flex items-center justify-center font-bold">
                    {staff.name.charAt(0)}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-gray-900">{staff.name}</p>
                    <p className="text-[10px] text-gray-400 uppercase font-bold tracking-widest">{staff.role}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold text-emerald-600">{staff.closed_leads} Closed</p>
                  <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">{staff.active_leads} Active</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Conversion Velocity Chart */}
        <div className="space-y-3">
          <h3 className="text-xs font-bold text-gray-900 flex items-center gap-2 px-1">
            <TrendingUp size={14} className="text-emerald-600" />
            Conversion Velocity (Leads Closed)
          </h3>
          <div className="bg-white p-4 rounded-3xl border border-gray-100 shadow-sm h-64 overflow-y-auto">
            <div className="flex h-full items-end gap-3 min-w-max">
              {conversionVelocity.map((entry: any) => {
                const heightPct = (entry.count / maxVelocity) * 100;
                return (
                  <div key={entry.date} className="flex flex-col items-center justify-end h-full w-12 gap-2">
                    <span className="text-[10px] font-bold text-gray-500">{entry.count}</span>
                    <div className="w-full h-40 flex items-end bg-slate-100 rounded-xl overflow-hidden">
                      <div
                        className="w-full bg-blue-500 rounded-xl transition-all duration-300"
                        style={{ height: `${Math.max(heightPct, 6)}%` }}
                        title={`${entry.count} leads closed`}
                      />
                    </div>
                    <span className="text-[10px] text-gray-400 font-bold">
                      {new Date(entry.date).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Distribution Heatmap / Pie Chart */}
        <div className="space-y-3">
          <h3 className="text-xs font-bold text-gray-900 flex items-center gap-2 px-1">
            <Activity size={14} className="text-purple-600" />
            Lead Distribution Heatmap
          </h3>
          <div className="bg-white p-4 rounded-3xl border border-gray-100 shadow-sm flex flex-col items-center">
            <div className="h-48 w-full flex items-center justify-center">
              <div
                className="w-40 h-40 rounded-full relative"
                style={{ background: pieBackground }}
                role="img"
                aria-label="Lead distribution chart"
              >
                <div className="absolute inset-8 bg-white rounded-full flex items-center justify-center">
                  <div className="text-center">
                    <p className="text-[10px] uppercase font-bold tracking-widest text-gray-400">Total</p>
                    <p className="text-lg font-bold text-gray-900">{totalDistribution}</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-8 gap-y-2 mt-4 w-full px-4">
              {distributionHeatmap.map((entry: any, index: number) => (
                <div key={entry.name} className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                  <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest truncate">{entry.name}</span>
                  <span className="text-[10px] font-bold text-gray-900 ml-auto">{entry.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="pb-10" />
      </div>
    </div>
  );
};
