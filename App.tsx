import React, { useState, useEffect } from 'react';
import { Layout } from './components/Layout';
import { LeadTable } from './components/LeadTable';
import { ChatDrawer } from './components/ChatDrawer';
import { Simulator } from './components/Simulator';
import { WebhookConfigModal } from './components/WebhookConfigModal';
import { NotificationToast } from './components/NotificationToast';
import { BotBuilder } from './components/BotBuilder';
import { AITraining } from './components/AITraining';
import { mockBackend } from './services/mockBackend';
import { liveApiService } from './services/liveApiService';
import { Driver, LeadStatus, Notification, BotSettings } from './types';
import { Users, FileText, CheckCircle, Send, MessageSquare, Database, Radio, Settings as SettingsIcon, Split, Server, ShieldCheck, AlertTriangle, Loader2, RefreshCw, WifiOff } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [selectedDriver, setSelectedDriver] = useState<Driver | null>(null);
  const [selectedBulkIds, setSelectedBulkIds] = useState<string[]>([]);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [showWebhookModal, setShowWebhookModal] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [retryTrigger, setRetryTrigger] = useState(0);
  
  // Data Source Toggle: Default to 'live' so user sees DB connection immediately
  const [dataSource, setDataSource] = useState<'mock' | 'live'>('live');
  const [systemHealth, setSystemHealth] = useState({ database: 'unknown', whatsapp: 'unknown', ai: 'unknown' });

  // Bot Strategy for Dashboard
  const [botSettings, setBotSettings] = useState<BotSettings | null>(null);

  // Sync with backend (Mock or Live)
  useEffect(() => {
    let unsubscribe: () => void = () => {};
    setConnectionError(null);

    const fetchData = async () => {
      setIsLoading(true);
      if (dataSource === 'mock') {
         setDrivers(mockBackend.getDrivers());
         setBotSettings(mockBackend.getBotSettings());
         unsubscribe = mockBackend.subscribe(() => {
             setDrivers(mockBackend.getDrivers());
             setBotSettings(mockBackend.getBotSettings());
             // Sync selected driver for mock
             setSelectedDriver(prev => {
                if(!prev) return null;
                const fresh = mockBackend.getDriver(prev.id);
                return fresh || prev;
             });
         });
         setIsLoading(false);
      } else {
         // Live Mode: Poll the real server
         try {
           const data = await liveApiService.getDrivers();
           setDrivers(data);
           const settings = await liveApiService.getBotSettings();
           setBotSettings(settings);

           // Initial Health Check
           const health = await liveApiService.checkHealth();
           setSystemHealth(health);

           // Subscribe triggers polling internally (every 15s)
           unsubscribe = liveApiService.subscribeToUpdates(async () => {
               try {
                   const updated = await liveApiService.getDrivers();
                   setDrivers(updated);
                   
                   // --- CRITICAL UPDATE: SYNC OPEN CHAT WINDOW ---
                   setSelectedDriver((prev) => {
                      if (!prev) return null;
                      const freshData = updated.find(d => d.id === prev.id);
                      // Only return fresh object if exists, otherwise keep old (to prevent crash, though unlikely)
                      // This ensures that when a new message comes in, the ChatDrawer re-renders
                      return freshData || prev;
                   });

                   const h = await liveApiService.checkHealth();
                   setSystemHealth(h);
               } catch (e) {
                   // Silent fail on poll error
               }
           });
           
           addNotification({
             type: 'info',
             title: 'Connected to Live Server',
             message: 'System is online.'
           });
         } catch (e: any) {
             console.error("Connection Error:", e);
             setConnectionError(e.message || "Failed to connect to backend server.");
         } finally {
             setIsLoading(false);
         }
      }
    };

    fetchData();
    return () => unsubscribe();
  }, [dataSource, activeTab, retryTrigger]); 

  // Notification Handler
  const addNotification = (notif: Omit<Notification, 'id'>) => {
    const newNotif = { ...notif, id: Date.now().toString() + Math.random() };
    setNotifications(prev => [newNotif, ...prev]);
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== newNotif.id));
    }, 5000);
  };

  const removeNotification = (id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  // UNIFIED UPDATE HANDLER
  const handleUpdateDriver = async (id: string, updates: Partial<Driver>) => {
      if (dataSource === 'mock') {
          mockBackend.updateDriverDetails(id, updates);
          // Manually update selectedDriver state to reflect changes instantly in the drawer
          setSelectedDriver(prev => prev && prev.id === id ? { ...prev, ...updates } : prev);
      } else {
          try {
             await liveApiService.updateDriver(id, updates);
             // Optimistic update for UI responsiveness
             setDrivers(prev => prev.map(d => d.id === id ? { ...d, ...updates } : d));
             setSelectedDriver(prev => prev && prev.id === id ? { ...prev, ...updates } : prev);
          } catch (e) {
             console.error("Update failed", e);
             addNotification({ type: 'warning', title: 'Update Failed', message: 'Could not save changes to server.' });
          }
      }
  };

  const handleStatusUpdate = (id: string, status: LeadStatus) => {
      handleUpdateDriver(id, { status });
  };

  const handleSendWelcome = (driver: Driver) => {
    if (dataSource === 'mock') {
        const msg = {
          id: Date.now().toString(),
          sender: 'system' as const,
          text: 'https://youtube.com/shorts/welcome-video',
          timestamp: Date.now(),
          type: 'video_link' as const
        };
        mockBackend.addMessage(driver.id, msg);
        
        addNotification({
          type: 'success',
          title: 'Welcome Video Sent',
          message: `Onboarding initiated for ${driver.name}`
        });
    } else {
        alert("Action Triggered on Live Server (Implementation Pending)");
    }
  };

  const handleBulkSend = () => {
    if (dataSource === 'mock') {
        selectedBulkIds.forEach(id => {
           mockBackend.addMessage(id, {
             id: Date.now().toString() + id,
             sender: 'system',
             text: '[Bulk Template]: Hello! Are you ready to drive?',
             timestamp: Date.now(),
             type: 'template' as const
           });
        });
        setShowBulkModal(false);
        setSelectedBulkIds([]);
        addNotification({
          type: 'success',
          title: 'Bulk Message Sent',
          message: `Sent to ${selectedBulkIds.length} drivers.`
        });
    } else {
        alert("Bulk Send not available in Read-Only Live Mode");
    }
  };

  const handleStrategyChange = async (strategy: 'HYBRID_BOT_FIRST' | 'AI_ONLY') => {
      if (!botSettings) return;
      const newSettings = { ...botSettings, routingStrategy: strategy };
      
      // Optimistic Update
      setBotSettings(newSettings);

      if (dataSource === 'mock') {
          mockBackend.updateBotSettings(newSettings);
      } else {
          try {
              await liveApiService.saveBotSettings(newSettings);
          } catch(e) {
              alert("Failed to update strategy");
          }
      }
  };

  // Derived Stats
  const stats = {
    total: drivers.length,
    flagged: drivers.filter(d => d.status === LeadStatus.FLAGGED_FOR_REVIEW).length,
    qualified: drivers.filter(d => d.status === LeadStatus.QUALIFIED).length,
    new: drivers.filter(d => d.status === LeadStatus.NEW).length
  };

  if (connectionError) {
      return (
          <div className="flex flex-col items-center justify-center h-screen bg-gray-50 text-center p-6">
              <div className="bg-red-50 p-6 rounded-full mb-6 animate-in zoom-in duration-300">
                  <WifiOff size={48} className="text-red-500" />
              </div>
              <h2 className="text-2xl font-bold text-gray-900 mb-2">Backend Connection Failed</h2>
              <p className="text-gray-600 max-w-md mb-8 leading-relaxed">
                  {connectionError}
              </p>
              <div className="flex flex-col sm:flex-row gap-4 w-full max-w-sm">
                  <button 
                    onClick={() => setRetryTrigger(prev => prev + 1)} 
                    className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
                  >
                      <RefreshCw size={18} /> Retry Connection
                  </button>
                  <button 
                    onClick={() => setDataSource('mock')} 
                    className="flex-1 bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 font-medium py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
                  >
                      <Database size={18} /> Use Simulator
                  </button>
              </div>
              <p className="mt-8 text-xs text-gray-400">
                  Ensure the backend server is running on port 3001.
              </p>
          </div>
      );
  }

  if (isLoading) {
      return (
          <div className="flex flex-col items-center justify-center h-screen bg-gray-50">
              <Loader2 className="animate-spin text-blue-600 mb-4" size={48} />
              <h2 className="text-xl font-bold text-gray-900">Connecting to Backend & Database...</h2>
              <p className="text-gray-500 mt-2">Please wait while the server starts up.</p>
          </div>
      );
  }

  return (
    <>
      <Layout activeTab={activeTab} onTabChange={setActiveTab}>
        
        {/* VIEW: DASHBOARD & LEADS */}
        {(activeTab === 'dashboard' || activeTab === 'leads') && (
        <div className="p-8 max-w-7xl mx-auto space-y-8">
          
          {/* Header & Stats (Dashboard Only) */}
          {activeTab === 'dashboard' && (
            <>
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                 <div>
                    <h2 className="text-2xl font-bold text-gray-900">Dashboard</h2>
                    <p className="text-gray-500">Welcome back. Here is your fleet recruitment overview.</p>
                 </div>
                 
                 <div className="flex items-center gap-2">
                   {/* Routing Strategy Widget */}
                   {botSettings && (
                     <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg p-1 shadow-sm mr-2">
                         <button 
                            onClick={() => handleStrategyChange('HYBRID_BOT_FIRST')}
                            className={`px-3 py-1.5 rounded text-xs font-bold flex items-center gap-1.5 transition-colors ${botSettings.routingStrategy === 'HYBRID_BOT_FIRST' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-600'}`}
                         >
                            <Split size={14} /> Bot Flow
                         </button>
                         <button 
                            onClick={() => handleStrategyChange('AI_ONLY')}
                            className={`px-3 py-1.5 rounded text-xs font-bold flex items-center gap-1.5 transition-colors ${botSettings.routingStrategy === 'AI_ONLY' ? 'bg-purple-600 text-white' : 'text-gray-400 hover:text-gray-600'}`}
                         >
                            <SettingsIcon size={14} /> AI Only
                         </button>
                     </div>
                   )}

                   {dataSource === 'live' && (
                     <button
                        onClick={() => setShowWebhookModal(true)}
                        className="bg-white border border-gray-200 text-gray-700 p-2 rounded-lg hover:bg-gray-50 transition-colors shadow-sm"
                        title="Configure Webhook"
                     >
                       <SettingsIcon size={20} />
                     </button>
                   )}
                   
                   {dataSource === 'live' && (
                       <button 
                           onClick={() => setRetryTrigger(prev => prev + 1)}
                           className="bg-white border border-gray-200 text-gray-500 hover:text-blue-600 p-2 rounded-lg hover:bg-blue-50 transition-colors shadow-sm mr-1"
                           title="Force Refresh Data"
                       >
                           <RefreshCw size={20} />
                       </button>
                   )}

                   <div className="flex items-center bg-white border border-gray-200 rounded-lg p-1 shadow-sm">
                      <button
                        onClick={() => setDataSource('mock')}
                        className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-2 ${dataSource === 'mock' ? 'bg-gray-100 text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}
                      >
                        <Database size={16} />
                        Simulator
                      </button>
                      <button
                        onClick={() => setDataSource('live')}
                        className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-2 ${dataSource === 'live' ? 'bg-green-100 text-green-800 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}
                      >
                        <Radio size={16} className={dataSource === 'live' ? 'animate-pulse' : ''} />
                        Live API
                      </button>
                   </div>
                 </div>
              </div>

              {/* LIVE MODE: SYSTEM STATUS WIDGET */}
              {dataSource === 'live' && (
                 <div className="bg-gray-900 rounded-xl p-4 text-white flex items-center justify-between shadow-lg">
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2">
                             <div className={`w-3 h-3 rounded-full ${systemHealth.database === 'connected' ? 'bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.6)]' : 'bg-red-500'}`}></div>
                             <span className="text-sm font-medium flex items-center gap-2">
                                <Server size={14} className="text-gray-400" /> Database
                             </span>
                        </div>
                        <div className="h-6 w-px bg-gray-700"></div>
                        <div className="flex items-center gap-2">
                             <div className={`w-3 h-3 rounded-full ${systemHealth.whatsapp === 'configured' ? 'bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.6)]' : 'bg-amber-500'}`}></div>
                             <span className="text-sm font-medium flex items-center gap-2">
                                <MessageSquare size={14} className="text-gray-400" /> WhatsApp API
                             </span>
                        </div>
                        <div className="h-6 w-px bg-gray-700"></div>
                         <div className="flex items-center gap-2">
                             <div className={`w-3 h-3 rounded-full ${systemHealth.ai === 'configured' ? 'bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.6)]' : 'bg-amber-500'}`}></div>
                             <span className="text-sm font-medium flex items-center gap-2">
                                <ShieldCheck size={14} className="text-gray-400" /> AI Engine
                             </span>
                        </div>
                    </div>
                    {systemHealth.whatsapp !== 'configured' && (
                        <button 
                          onClick={() => setShowWebhookModal(true)}
                          className="text-xs bg-amber-500/20 text-amber-300 px-3 py-1 rounded-full border border-amber-500/50 flex items-center gap-1 hover:bg-amber-500/30 transition-colors"
                        >
                           <AlertTriangle size={12} /> Configure Credentials
                        </button>
                    )}
                 </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-gray-500 text-sm font-medium">Total Leads</span>
                    <div className="p-2 bg-blue-50 text-blue-600 rounded-lg">
                      <Users size={20} />
                    </div>
                  </div>
                  <div className="text-3xl font-bold text-gray-900">{stats.total}</div>
                </div>

                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-gray-500 text-sm font-medium">Flagged Docs</span>
                    <div className="p-2 bg-amber-50 text-amber-600 rounded-lg">
                      <FileText size={20} />
                    </div>
                  </div>
                  <div className="text-3xl font-bold text-gray-900">{stats.flagged}</div>
                  <div className="text-xs text-amber-600 mt-2 font-medium">Needs Review</div>
                </div>

                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-gray-500 text-sm font-medium">Qualified</span>
                    <div className="p-2 bg-green-50 text-green-600 rounded-lg">
                      <CheckCircle size={20} />
                    </div>
                  </div>
                  <div className="text-3xl font-bold text-gray-900">{stats.qualified}</div>
                </div>
                
                 <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-gray-500 text-sm font-medium">New Leads</span>
                    <div className="p-2 bg-purple-50 text-purple-600 rounded-lg">
                      <MessageSquare size={20} />
                    </div>
                  </div>
                  <div className="text-3xl font-bold text-gray-900">{stats.new}</div>
                </div>
              </div>
            </>
          )}

          {/* Table Area */}
          <div className="h-[600px] flex flex-col">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-gray-900">
                {activeTab === 'dashboard' ? 'Recent Activity' : 'Lead Management'}
              </h3>
              {selectedBulkIds.length > 0 && (
                <button 
                  onClick={() => setShowBulkModal(true)}
                  className="bg-black text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors flex items-center gap-2 animate-in fade-in slide-in-from-right-5"
                >
                  <Send size={16} />
                  Message Selected ({selectedBulkIds.length})
                </button>
              )}
            </div>
            
            {dataSource === 'live' && drivers.length === 0 && (
                <div className="bg-amber-50 text-amber-800 p-4 rounded-lg mb-4 border border-amber-200 text-sm">
                    <strong>Note:</strong> Attempting to fetch live data. If empty, ensure database has records or create one via Webhook.
                </div>
            )}

            <LeadTable 
              drivers={drivers}
              onSelectDriver={setSelectedDriver}
              onSendWelcome={handleSendWelcome}
              selectedIds={selectedBulkIds}
              onBulkSelect={setSelectedBulkIds}
            />
          </div>
        </div>
        )}

        {/* VIEW: BOT STUDIO */}
        {activeTab === 'bot-studio' && <BotBuilder isLiveMode={dataSource === 'live'} />}

        {/* VIEW: AI TRAINING */}
        {activeTab === 'ai-training' && <AITraining isLiveMode={dataSource === 'live'} />}

        {/* Modals & Drawers */}
        {showWebhookModal && (
          <WebhookConfigModal 
            onClose={() => setShowWebhookModal(false)}
            onSuccess={() => {
              addNotification({
                type: 'success',
                title: 'Webhook Configured',
                message: 'Meta App settings updated successfully.'
              });
            }}
          />
        )}

        {showBulkModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
             <div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-md m-4">
               <h3 className="text-lg font-bold mb-4">Send Bulk Message</h3>
               <div className="flex gap-3">
                 <button onClick={() => setShowBulkModal(false)} className="flex-1 px-4 py-2 border rounded-lg">Cancel</button>
                 <button onClick={handleBulkSend} className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg">Send</button>
               </div>
             </div>
          </div>
        )}

        <ChatDrawer 
          driver={selectedDriver} 
          onClose={() => setSelectedDriver(null)}
          onStatusUpdate={handleStatusUpdate}
          onUpdateDriver={handleUpdateDriver}
        />
        
        <NotificationToast notifications={notifications} onDismiss={removeNotification} />
      </Layout>
      
      {/* Simulator: Updated to use new Bot Logic */}
      {dataSource === 'mock' && <Simulator onNotify={addNotification} />}
    </>
  );
}