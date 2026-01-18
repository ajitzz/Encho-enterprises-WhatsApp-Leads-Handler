
import React, { useState, useEffect } from 'react';
import { X, Power, Server, Database, Activity, Zap, Cpu } from 'lucide-react';
import { liveApiService } from '../services/liveApiService';

interface SettingsModalProps {
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ onClose }) => {
  const [loading, setLoading] = useState(true);
  const [killSwitchActive, setKillSwitchActive] = useState(false);
  const [systemState, setSystemState] = useState({
    webhook: true,
    bot: true,
    scheduler: true
  });

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const data = await liveApiService.getSystemSettings();
      // Logic: If ANY critical service is enabled, Kill Switch is OFF (System is Alive). 
      // Kill Switch is strictly "ON" only if everything is disabled.
      const isEverythingOff = !data.webhook_ingest_enabled && !data.automation_enabled && !data.sending_enabled;
      
      setKillSwitchActive(isEverythingOff);
      setSystemState({
        webhook: data.webhook_ingest_enabled,
        bot: data.automation_enabled,
        scheduler: data.sending_enabled
      });
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleKillSwitch = async () => {
    const newKillState = !killSwitchActive; // Toggling the switch
    setLoading(true);

    // If Kill Switch becomes ON (True) -> We want System OFF (False)
    // If Kill Switch becomes OFF (False) -> We want System ON (True)
    const targetSystemValue = !newKillState;

    const newSettings = {
      webhook_ingest_enabled: targetSystemValue,
      automation_enabled: targetSystemValue,
      sending_enabled: targetSystemValue
    };

    try {
      await liveApiService.updateSystemSettings(newSettings);
      setKillSwitchActive(newKillState);
      setSystemState({
        webhook: targetSystemValue,
        bot: targetSystemValue,
        scheduler: targetSystemValue
      });
    } catch (e) {
      alert("Failed to update system state. Check connection.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden border border-gray-200">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-gray-50">
          <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Activity size={20} className="text-gray-500" />
            System Settings
          </h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-200 rounded-full transition-colors text-gray-500">
            <X size={20} />
          </button>
        </div>

        <div className="p-8">
          {/* MASTER KILL SWITCH UI */}
          <div className={`relative rounded-2xl border-2 p-6 transition-all duration-300 ${killSwitchActive ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'}`}>
            
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className={`p-3 rounded-full shadow-inner ${killSwitchActive ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'}`}>
                  <Power size={28} />
                </div>
                <div>
                  <h3 className="text-lg font-black text-gray-900 uppercase tracking-tight">Master Kill Switch</h3>
                  <p className={`text-xs font-bold uppercase tracking-wide mt-0.5 ${killSwitchActive ? 'text-red-600' : 'text-green-600'}`}>
                    Status: {killSwitchActive ? 'ENGAGED (SYSTEM OFFLINE)' : 'DISENGAGED (SYSTEM ONLINE)'}
                  </p>
                </div>
              </div>
              
              {/* Toggle Button */}
              <button 
                onClick={handleToggleKillSwitch}
                disabled={loading}
                className={`relative w-16 h-9 rounded-full transition-colors focus:outline-none shadow-sm ${killSwitchActive ? 'bg-red-500 hover:bg-red-600' : 'bg-green-500 hover:bg-green-600'} disabled:opacity-50`}
                title={killSwitchActive ? "Turn System Back ON" : "Kill System"}
              >
                <span className={`absolute top-1 left-1 bg-white w-7 h-7 rounded-full shadow-md transform transition-transform duration-300 flex items-center justify-center ${killSwitchActive ? 'translate-x-7' : 'translate-x-0'}`}>
                   {loading ? <div className="w-4 h-4 border-2 border-gray-300 border-t-black rounded-full animate-spin" /> : (killSwitchActive ? <Power size={14} className="text-red-500" /> : <Zap size={14} className="text-green-500" />)}
                </span>
              </button>
            </div>

            <p className="text-sm text-gray-600 leading-relaxed">
              {killSwitchActive 
                ? "The system is currently in SLEEP MODE. All server processes, database queries, and automation workflows are suspended. No new leads will be processed."
                : "The system is FULLY OPERATIONAL. Webhooks are active, the database is querying, and automation bots are responding to customers."}
            </p>
          </div>

          {/* SYSTEM STATUS INDICATORS */}
          <div className="mt-8 space-y-4">
            <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Operational Status</h4>
            
            {/* Server */}
            <div className="flex items-center justify-between p-3 rounded-xl border border-gray-100 bg-white shadow-sm">
                <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${!systemState.webhook ? 'bg-gray-100 text-gray-400' : 'bg-blue-50 text-blue-600'}`}>
                        <Server size={18} />
                    </div>
                    <div>
                        <div className="text-sm font-bold text-gray-800">Webhook Server</div>
                        <div className="text-[10px] text-gray-500">Inbound Traffic Handler</div>
                    </div>
                </div>
                <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold ${!systemState.webhook ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                    <div className={`w-2 h-2 rounded-full ${!systemState.webhook ? 'bg-red-500' : 'bg-green-500 animate-pulse'}`} />
                    {!systemState.webhook ? 'OFFLINE' : 'LISTENING'}
                </div>
            </div>

            {/* Database */}
            <div className="flex items-center justify-between p-3 rounded-xl border border-gray-100 bg-white shadow-sm">
                <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${!systemState.scheduler ? 'bg-gray-100 text-gray-400' : 'bg-purple-50 text-purple-600'}`}>
                        <Database size={18} />
                    </div>
                    <div>
                        <div className="text-sm font-bold text-gray-800">Database & Scheduler</div>
                        <div className="text-[10px] text-gray-500">Neon PostgreSQL Connection</div>
                    </div>
                </div>
                <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold ${!systemState.scheduler ? 'bg-gray-100 text-gray-500' : 'bg-green-100 text-green-700'}`}>
                    <div className={`w-2 h-2 rounded-full ${!systemState.scheduler ? 'bg-gray-400' : 'bg-green-500 animate-pulse'}`} />
                    {!systemState.scheduler ? 'SLEEPING' : 'ACTIVE'}
                </div>
            </div>

            {/* Bot Logic */}
            <div className="flex items-center justify-between p-3 rounded-xl border border-gray-100 bg-white shadow-sm">
                <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${!systemState.bot ? 'bg-gray-100 text-gray-400' : 'bg-amber-50 text-amber-600'}`}>
                        <Cpu size={18} />
                    </div>
                    <div>
                        <div className="text-sm font-bold text-gray-800">Bot Logic Engine</div>
                        <div className="text-[10px] text-gray-500">Automated Responses</div>
                    </div>
                </div>
                <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold ${!systemState.bot ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                    <div className={`w-2 h-2 rounded-full ${!systemState.bot ? 'bg-red-500' : 'bg-green-500 animate-pulse'}`} />
                    {!systemState.bot ? 'STOPPED' : 'RUNNING'}
                </div>
            </div>

          </div>
        </div>
        
        <div className="bg-gray-50 p-4 border-t border-gray-100 flex justify-end">
            <button onClick={onClose} className="px-6 py-2.5 bg-white border border-gray-300 rounded-lg text-sm font-bold text-gray-700 hover:bg-gray-100 transition-colors">
                Close
            </button>
        </div>
      </div>
    </div>
  );
};
