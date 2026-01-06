import React, { useState, useEffect } from 'react';
import { Layout } from './components/Layout';
import { LeadTable } from './components/LeadTable';
import { ChatDrawer } from './components/ChatDrawer';
import { Simulator } from './components/Simulator';
import { WebhookConfigModal } from './components/WebhookConfigModal';
import { NotificationToast } from './components/NotificationToast';
import { BotBuilder } from './components/BotBuilder';
import { AITraining } from './components/AITraining';
import { AssistantChat } from './components/AssistantChat';
import { mockBackend } from './services/mockBackend';
import { liveApiService } from './services/liveApiService';
import { Driver, LeadStatus, Notification, BotSettings, Message } from './types';
import { Users, FileText, CheckCircle, Send, MessageSquare, Database, Radio, Settings as SettingsIcon, Split, Bot } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [selectedDriver, setSelectedDriver] = useState<Driver | null>(null);
  const [selectedBulkIds, setSelectedBulkIds] = useState<string[]>([]);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [showWebhookModal, setShowWebhookModal] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  
  // Data Source Toggle: 'mock' or 'live'
  const [dataSource, setDataSource] = useState<'mock' | 'live'>('mock');

  // Bot Strategy for Dashboard
  const [botSettings, setBotSettings] = useState<BotSettings | null>(null);

  // Sync with backend (Mock or Live)
  useEffect(() => {
    let unsubscribe: () => void = () => {};

    const fetchData = async () => {
      if (dataSource === 'mock') {
         setDrivers(mockBackend.getDrivers());
         setBotSettings(mockBackend.getBotSettings());
         unsubscribe = mockBackend.subscribe(() => {
             setDrivers(mockBackend.getDrivers());
             setBotSettings(mockBackend.getBotSettings());
             // Update selected driver if open
             if (selectedDriver) {
                const updated = mockBackend.getDriver(selectedDriver.id);
                if (updated) setSelectedDriver(updated);
             }
         });
      } else {
         // Live Mode: Poll the real server
         try {
           const data = await liveApiService.getDrivers();
           setDrivers(data);
           const settings = await liveApiService.getBotSettings();
           setBotSettings(settings);

           // Subscribe triggers polling internally (now every 2s)
           unsubscribe = liveApiService.subscribeToUpdates(async () => {
               try {
                   const updated = await liveApiService.getDrivers();
                   setDrivers(updated);
               } catch (e) {
                   // Silent fail on poll error to avoid spamming console
               }
           });
           
           addNotification({
             type: 'info',
             title: 'Connected to Live Server',
             message: 'Polling active (2s interval)'
           });
         } catch (e) {
             addNotification({
                type: 'warning',
                title: 'Connection Failed',
                message: 'Ensure node server.js is running.'
             });
         }
      }
    };

    fetchData();
    return () => unsubscribe();
  }, [dataSource, activeTab]); 

  // Auto-sync Chat Drawer when polling updates the drivers list
  useEffect(() => {
    if (selectedDriver && dataSource === 'live') {
      const updated = drivers.find(d => d.id === selectedDriver.id);
      // If we found the driver in the new list, update the selectedDriver state
      // to reflect new messages/status
      if (updated && updated !== selectedDriver) {
        setSelectedDriver(updated);
      }
    }
  }, [drivers, selectedDriver, dataSource]);

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

  // Handlers
  const handleUpdateDriver = async (id: string, updates: Partial<Driver>) => {
    if (dataSource === 'mock') {
        if (updates.status) mockBackend.updateDriverStatus(id, updates.status);
        mockBackend.updateDriverDetails(id, updates);
    } else {
        try {
            await liveApiService.updateDriver(id, updates);
            // Optimistic update
            const updated = drivers.map(d => d.id === id ? { ...d, ...updates } : d);
            setDrivers(updated);
            if (selectedDriver && selectedDriver.id === id) {
                setSelectedDriver({ ...selectedDriver, ...updates });
            }
        } catch (e) {
            alert("Failed to update driver details");
        }
    }
  };

  const handleSendMessage = async (text: string) => {
    if (!selectedDriver) return;
    
    if (dataSource === 'mock') {
        const msg: Message = {
            id: Date.now().toString(),
            sender: 'agent',
            text: text,
            timestamp: Date.now(),
            type: 'text'
        };
        mockBackend.addMessage(selectedDriver.id, msg);
    } else {
        try {
            await liveApiService.sendMessage(selectedDriver.id, text);
            // Optimistic update for immediate feedback
            const msg: Message = {
                id: Date.now().toString(),
                sender: 'agent',
                text: text,
                timestamp: Date.now(),
                type: 'text'
            };
            const updatedDriver = {
                ...selectedDriver,
                lastMessage: text,
                lastMessageTime: Date.now(),
                messages: [...selectedDriver.messages, msg]
            };
            setSelectedDriver(updatedDriver);
            setDrivers(prev => prev.map(d => d.id === selectedDriver.id ? updatedDriver : d));
        } catch (e) {
            alert("Failed to send message via WhatsApp API");
        }
    }
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
         handleSendMessage('https://youtube.com/shorts/welcome-video');
         addNotification({
            type: 'success',
            title: 'Welcome Video Sent',
            message: 'Video link sent via WhatsApp'
         });
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

  const handleStrategyChange = async (strategy: 'HYBRID_BOT_FIRST' | 'AI_ONLY' | 'BOT_ONLY') => {
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
                            <Split size={14} /> Hybrid
                         </button>
                         <button 
                            onClick={() => handleStrategyChange('BOT_ONLY')}
                            className={`px-3 py-1.5 rounded text-xs font-bold flex items-center gap-1.5 transition-colors ${botSettings.routingStrategy === 'BOT_ONLY' ? 'bg-green-600 text-white' : 'text-gray-400 hover:text-gray-600'}`}
                         >
                            <Bot size={14} /> Bot Only
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
                    <strong>Note:</strong> Ensure <code>node server.js</code> is running on port 3000 to see live data.
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
          onSendMessage={handleSendMessage}
          onUpdateDriver={handleUpdateDriver}
        />
        
        {/* NEW: Fleet Commander Assistant (Jarvis) */}
        {dataSource === 'live' && <AssistantChat />}
        
        <NotificationToast notifications={notifications} onDismiss={removeNotification} />
      </Layout>
      
      {/* Simulator: Updated to use new Bot Logic */}
      {dataSource === 'mock' && <Simulator onNotify={addNotification} />}
    </>
  );
}
