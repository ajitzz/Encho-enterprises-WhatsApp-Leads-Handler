import React, { useState, useEffect } from 'react';
import { Layout } from './components/Layout';
import { LeadTable } from './components/LeadTable';
import { ChatDrawer } from './components/ChatDrawer';
import { Simulator } from './components/Simulator';
import { WebhookConfigModal } from './components/WebhookConfigModal';
import { NotificationToast } from './components/NotificationToast';
import { mockBackend } from './services/mockBackend';
import { liveApiService } from './services/liveApiService';
import { Driver, LeadStatus, Notification } from './types';
import { Users, FileText, CheckCircle, Send, MessageSquare, Database, Radio, Settings as SettingsIcon } from 'lucide-react';

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

  // Sync with backend (Mock or Live)
  useEffect(() => {
    let unsubscribe: () => void = () => {};

    const fetchData = async () => {
      if (dataSource === 'mock') {
         setDrivers(mockBackend.getDrivers());
         unsubscribe = mockBackend.subscribe(() => setDrivers(mockBackend.getDrivers()));
      } else {
         // Live Mode: Poll the real server
         const data = await liveApiService.getDrivers();
         setDrivers(data);
         unsubscribe = liveApiService.subscribeToUpdates(async () => {
             const updated = await liveApiService.getDrivers();
             setDrivers(updated);
         });
         
         addNotification({
           type: 'info',
           title: 'Connected to Live Server',
           message: 'Polling http://localhost:3000/api/drivers'
         });
      }
    };

    fetchData();
    return () => unsubscribe();
  }, [dataSource]);

  // Notification Handler
  const addNotification = (notif: Omit<Notification, 'id'>) => {
    const newNotif = { ...notif, id: Date.now().toString() + Math.random() };
    setNotifications(prev => [newNotif, ...prev]);
    // Auto dismiss after 5 seconds
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== newNotif.id));
    }, 5000);
  };

  const removeNotification = (id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  // Handlers
  const handleStatusUpdate = (id: string, status: LeadStatus) => {
    if (dataSource === 'mock') {
        mockBackend.updateDriverStatus(id, status);
        if (selectedDriver && selectedDriver.id === id) {
          setSelectedDriver(prev => prev ? ({ ...prev, status }) : null);
        }
    } else {
        // In a real app, you would call liveApiService.updateStatus(id, status)
        alert("Status updates in Live Mode require the full backend implementation. Currently Read-Only.");
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
        setTimeout(() => {
          mockBackend.addMessage(driver.id, {
             id: Date.now().toString() + 'follow',
             sender: 'system' as const,
             text: 'Please reply with your Vehicle Registration Number to proceed.',
             timestamp: Date.now(),
             type: 'text' as const
          });
        }, 1500);
        
        addNotification({
          type: 'success',
          title: 'Welcome Video Sent',
          message: `Onboarding initiated for ${driver.name}`
        });
    } else {
        // Trigger backend welcome endpoint
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
             type: 'template'
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
        <div className="p-8 max-w-7xl mx-auto space-y-8">
          
          {/* Dashboard Header Stats */}
          {activeTab === 'dashboard' && (
            <>
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                 <div>
                    <h2 className="text-2xl font-bold text-gray-900">Dashboard</h2>
                    <p className="text-gray-500">Welcome back. Here is your fleet recruitment overview.</p>
                 </div>
                 
                 {/* Live Mode Toggle & Webhook Config */}
                 <div className="flex items-center gap-2">
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

              <div className="bg-gradient-to-r from-gray-900 to-black rounded-2xl p-8 text-white flex justify-between items-center shadow-xl">
                 <div>
                   <h3 className="text-xl font-bold mb-2">Automate your hiring</h3>
                   <p className="text-gray-400 max-w-lg">
                     The AI bot (powered by Google Gemini) is active. It is currently monitoring incoming messages for driving licenses and questions about onboarding.
                   </p>
                 </div>
                 <div className="bg-white/10 backdrop-blur-md px-6 py-3 rounded-lg border border-white/10">
                   <span className="text-green-400 font-mono text-sm">● System Online</span>
                 </div>
              </div>
            </>
          )}

          {/* Leads Table View */}
          <div className="h-[600px] flex flex-col">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-gray-900">Recent Activity</h3>
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

        {/* Webhook Configuration Modal */}
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

        {/* Bulk Message Modal */}
        {showBulkModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
             <div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-md m-4">
               <h3 className="text-lg font-bold mb-4">Send Bulk Message</h3>
               <p className="text-sm text-gray-500 mb-4">
                 Sending to <span className="font-bold text-black">{selectedBulkIds.length}</span> recipients.
               </p>
               
               <div className="space-y-3 mb-6">
                 <div className="border p-3 rounded-lg bg-gray-50 border-gray-200 cursor-pointer hover:border-blue-500 transition-colors">
                   <p className="font-semibold text-sm">Template: Welcome_V1</p>
                   <p className="text-xs text-gray-500 mt-1">"Hello! Are you ready to drive with Uber? Reply YES to start."</p>
                 </div>
                 <div className="border p-3 rounded-lg bg-white border-gray-200 cursor-pointer hover:border-blue-500 transition-colors opacity-50">
                   <p className="font-semibold text-sm">Template: Follow_Up_Docs</p>
                   <p className="text-xs text-gray-500 mt-1">"We are still waiting for your documents. Please upload them here."</p>
                 </div>
               </div>

               <div className="flex gap-3">
                 <button 
                   onClick={() => setShowBulkModal(false)}
                   className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                 >
                   Cancel
                 </button>
                 <button 
                   onClick={handleBulkSend}
                   className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                 >
                   Send Blast
                 </button>
               </div>
             </div>
          </div>
        )}

        <ChatDrawer 
          driver={selectedDriver} 
          onClose={() => setSelectedDriver(null)}
          onStatusUpdate={handleStatusUpdate}
        />
        
        <NotificationToast notifications={notifications} onDismiss={removeNotification} />
      </Layout>
      
      {/* Simulator only visible in Mock mode to avoid confusion */}
      {dataSource === 'mock' && <Simulator onNotify={addNotification} />}
    </>
  );
}