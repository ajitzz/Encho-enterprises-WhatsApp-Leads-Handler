
import React, { useState, useEffect } from 'react';
import { 
  BarChart3, 
  TrendingUp, 
  Users, 
  Zap, 
  Clock, 
  AlertTriangle, 
  CheckCircle, 
  ChevronRight, 
  Loader2, 
  ArrowLeft,
  Activity,
  Calendar,
  MessageSquare
} from 'lucide-react';
import { liveApiService } from '../services/liveApiService.ts';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer, 
  Cell,
  PieChart,
  Pie
} from 'recharts';

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
          <div className="bg-white p-4 rounded-3xl border border-gray-100 shadow-sm h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={conversionVelocity}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                <XAxis 
                  dataKey="date" 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fontSize: 10, fill: '#9ca3af' }} 
                  tickFormatter={(val) => new Date(val).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#9ca3af' }} />
                <Tooltip 
                  contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                  labelStyle={{ fontWeight: 'bold', marginBottom: '4px' }}
                />
                <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Distribution Heatmap / Pie Chart */}
        <div className="space-y-3">
          <h3 className="text-xs font-bold text-gray-900 flex items-center gap-2 px-1">
            <Activity size={14} className="text-purple-600" />
            Lead Distribution Heatmap
          </h3>
          <div className="bg-white p-4 rounded-3xl border border-gray-100 shadow-sm flex flex-col items-center">
            <div className="h-48 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={distributionHeatmap}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={5}
                    dataKey="count"
                    nameKey="name"
                  >
                    {distributionHeatmap.map((entry: any, index: number) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip 
                    contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                  />
                </PieChart>
              </ResponsiveContainer>
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
