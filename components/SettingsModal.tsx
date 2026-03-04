import React, { useState, useEffect } from 'react';
import { X, Power, Server, Database, Activity, Zap, Cpu, FileSpreadsheet } from 'lucide-react';
import { liveApiService } from '../services/liveApiService';

interface SettingsModalProps {
  onClose: () => void;
}

interface OperationalStatus {
  postgres: { state: string; reason?: string | null };
  integrations: {
    googleSheets: {
      state: string;
      configured: boolean;
      reason?: string;
      spreadsheetTitle?: string;
      customersTabName?: string;
      messagesTabName?: string;
      customersTabExists?: boolean;
      messagesTabExists?: boolean;
      tabMode?: string;
    };
  };
  driverExcelSync: {
    state: string;
    lastSuccessAt?: string;
    lastError?: string;
    inProgress?: boolean;
    hasQueuedSync?: boolean;
  };
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ onClose }) => {
  const [loading, setLoading] = useState(true);
  const [killSwitchActive, setKillSwitchActive] = useState(false);
  const [systemState, setSystemState] = useState({
    webhook: true,
    bot: true,
    scheduler: true
  });
  const [operationalStatus, setOperationalStatus] = useState<OperationalStatus | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const [settingsData, statusData] = await Promise.all([
        liveApiService.getSystemSettings(),
        liveApiService.getSystemOperationalStatus()
      ]);

      const isEverythingOff = !settingsData.webhook_ingest_enabled && !settingsData.automation_enabled && !settingsData.sending_enabled;
      setKillSwitchActive(isEverythingOff);
      setSystemState({
        webhook: settingsData.webhook_ingest_enabled,
        bot: settingsData.automation_enabled,
        scheduler: settingsData.sending_enabled
      });
      setOperationalStatus(statusData);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleKillSwitch = async () => {
    const newKillState = !killSwitchActive;
    setLoading(true);

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
      const refreshedStatus = await liveApiService.getSystemOperationalStatus();
      setOperationalStatus(refreshedStatus);
    } catch (e) {
      alert('Failed to update system state. Check connection.');
    } finally {
      setLoading(false);
    }
  };

  const googleSheets = operationalStatus?.integrations?.googleSheets;
  const driverExcelSync = operationalStatus?.driverExcelSync;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden border border-gray-200">
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

              <button
                onClick={handleToggleKillSwitch}
                disabled={loading}
                className={`relative w-16 h-9 rounded-full transition-colors focus:outline-none shadow-sm ${killSwitchActive ? 'bg-red-500 hover:bg-red-600' : 'bg-green-500 hover:bg-green-600'} disabled:opacity-50`}
                title={killSwitchActive ? 'Turn System Back ON' : 'Kill System'}
              >
                <span className={`absolute top-1 left-1 bg-white w-7 h-7 rounded-full shadow-md transform transition-transform duration-300 flex items-center justify-center ${killSwitchActive ? 'translate-x-7' : 'translate-x-0'}`}>
                  {loading ? <div className="w-4 h-4 border-2 border-gray-300 border-t-black rounded-full animate-spin" /> : (killSwitchActive ? <Power size={14} className="text-red-500" /> : <Zap size={14} className="text-green-500" />)}
                </span>
              </button>
            </div>

            <p className="text-sm text-gray-600 leading-relaxed">
              {killSwitchActive
                ? 'The system is currently in SLEEP MODE. All server processes, database queries, and automation workflows are suspended. No new leads will be processed.'
                : 'The system is FULLY OPERATIONAL. Webhooks are active, the database is querying, and automation bots are responding to customers.'}
            </p>
          </div>

          <div className="mt-8 space-y-4">
            <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Operational Status</h4>

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
                {!systemState.scheduler ? 'SLEEPING' : operationalStatus?.postgres?.state === 'connected' ? 'ACTIVE' : 'DEGRADED'}
              </div>
            </div>

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

            <div className="p-3 rounded-xl border border-gray-100 bg-white shadow-sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-lg ${googleSheets?.state === 'connected' ? 'bg-emerald-50 text-emerald-600' : googleSheets?.state === 'error' ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-400'}`}>
                    <FileSpreadsheet size={18} />
                  </div>
                  <div>
                    <div className="text-sm font-bold text-gray-800">Google Sheets (Driver Excel)</div>
                    <div className="text-[10px] text-gray-500">Spreadsheet sync and connection check</div>
                  </div>
                </div>
                <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold ${googleSheets?.state === 'connected' ? 'bg-green-100 text-green-700' : googleSheets?.state === 'error' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>
                  <div className={`w-2 h-2 rounded-full ${googleSheets?.state === 'connected' ? 'bg-green-500 animate-pulse' : googleSheets?.state === 'error' ? 'bg-red-500' : 'bg-gray-400'}`} />
                  {googleSheets?.state === 'connected' ? 'CONNECTED' : googleSheets?.state === 'error' ? 'ERROR' : 'NOT CONFIGURED'}
                </div>
              </div>
              <div className="mt-2 text-[11px] text-gray-600 space-y-1">
                {googleSheets?.spreadsheetTitle && <div><b>Spreadsheet:</b> {googleSheets.spreadsheetTitle}</div>}
                {googleSheets?.customersTabName && <div><b>Customers Tab:</b> {googleSheets.customersTabName} ({googleSheets.customersTabExists ? 'found' : 'missing'})</div>}
                {googleSheets?.messagesTabName && <div><b>Messages Tab:</b> {googleSheets.messagesTabName} ({googleSheets.messagesTabExists ? 'found' : 'missing'})</div>}
                {driverExcelSync?.state && (
                  <div>
                    <b>Last Sync:</b> {driverExcelSync.state}
                    {driverExcelSync.lastSuccessAt ? ` • ${new Date(driverExcelSync.lastSuccessAt).toLocaleString()}` : ''}
                  </div>
                )}
                {(googleSheets?.reason || driverExcelSync?.lastError) && (
                  <div className="text-red-600"><b>Issue:</b> {googleSheets?.reason || driverExcelSync?.lastError}</div>
                )}
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
