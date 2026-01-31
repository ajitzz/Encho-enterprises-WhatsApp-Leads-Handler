
import React, { useState, useEffect } from 'react';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { Layout } from './components/Layout';
import { LeadTable } from './components/LeadTable';
import { LeadManager } from './components/LeadManager';
import { ChatDrawer } from './components/ChatDrawer';
import { Simulator } from './components/Simulator';
import { WebhookConfigModal } from './components/WebhookConfigModal';
import { NotificationToast } from './components/NotificationToast';
import { BotBuilder } from './components/BotBuilder';
import { AssistantChat } from './components/AssistantChat';
import { MediaLibrary } from './components/MediaLibrary';
import { PublicShowcase } from './components/PublicShowcase'; 
import { PrivacyPolicy } from './components/PrivacyPolicy'; 
import { TermsOfService } from './components/TermsOfService'; 
import { DataDeletion } from './components/DataDeletion'; 
import { SystemMonitor } from './components/SystemMonitor'; 
import { SettingsModal } from './components/SettingsModal'; 
import { Login } from './components/Login'; 
import { mockBackend } from './services/mockBackend';
import { liveApiService, setAuthToken } from './services/liveApiService';
import { Driver, LeadStatus, AppNotification, BotSettings, Message } from './types';
import { Users, FileText, CheckCircle, Send, MessageSquare, Database, Radio, Settings as SettingsIcon, Repeat, AlertTriangle } from 'lucide-react';

const FALLBACK_CLIENT_ID = "764842119656-ufuaijbp0kb4m0ql6tjhdmmr3hr24t15.apps.googleusercontent.com";
const ENV_CLIENT_ID = (import.meta as any)?.env?.VITE_GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_ID = (ENV_CLIENT_ID || FALLBACK_CLIENT_ID).replace(/^['"]|['"]$/g, '').trim();

export default function App() {
  const [isShowcaseMode, setIsShowcaseMode] = useState(false);
  const [activePublicPage, setActivePublicPage] = useState<'none' | 'privacy' | 'terms' | 'deletion'>('none');
  const [showcaseToken, setShowcaseToken] = useState<string | undefined>(undefined);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userProfile, setUserProfile] = useState<any>(null);

  useEffect(() => {
      const path = window.location.pathname;
      if (path === '/privacy-policy') { setActivePublicPage('privacy'); return; }
      if (path === '/terms' || path === '/terms-of-service') { setActivePublicPage('terms'); return; }
      if (path === '/data-deletion') { setActivePublicPage('deletion'); return; }
      if (path.startsWith('/showcase')) {
          setIsShowcaseMode(true);
          const parts = path.split('/showcase/');
          if (parts.length > 1 && parts[1].trim() !== '') setShowcaseToken(decodeURIComponent(parts[1]));
          return;
      }
      const token = localStorage.getItem('uber_fleet_auth_token');
      if (token) { setAuthToken(token); setIsAuthenticated(true); }
  }, []);

  const [activeTab, setActiveTab] = useState('dashboard');
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [selectedDriver, setSelectedDriver] = useState<Driver | null>(null);
  const [selectedBulkIds, setSelectedBulkIds] = useState<string[]>([]);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [showWebhookModal, setShowWebhookModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false); 
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [botSettings, setBotSettings] = useState<BotSettings | null>(null);
  const [isRepeatToggling, setIsRepeatToggling] = useState(false);
  
  // Data Source Logic (Persist & Default)
  const [dataSource, setDataSource] = useState<'mock' | 'live'>(() => {
      const saved = localStorage.getItem('uber_fleet_data_source');
      if (saved === 'live' || saved === 'mock') return saved;
      return process.env.NODE_ENV === 'production' ? 'live' : 'mock';
  });

  // --- HEARTBEAT CRON TRIGGER ---
  // Since we are on Vercel Serverless, we cannot rely on server-side setInterval.
  // This client-side effect pings the server to process the queue as long as the dashboard is open.
  useEffect(() => {
      if (dataSource !== 'live' || !isAuthenticated) return;
      
      const triggerCron = async () => {
          try {
              // We use fetch directly to avoid auth headers if public, but here we add them just in case
              await fetch('/api/cron/process-queue', {
                  headers: { 'Authorization': `Bearer ${localStorage.getItem('uber_fleet_auth_token')}` }
              });
          } catch(e) { console.error("Heartbeat skipped"); }
      };

      // Run every 30 seconds
      const interval = setInterval(triggerCron, 30000);
      triggerCron(); // Run immediately on load

      return () => clearInterval(interval);
  }, [dataSource, isAuthenticated]);

  const changeDataSource = (mode: 'mock' | 'live') => {
      setDataSource(mode);
      localStorage.setItem('uber_fleet_data_source', mode);
  };

  useEffect(() => {
      if (!isAuthenticated) return;
      const loadSettings = async () => {
          try {
              const s = dataSource === 'live' ? await liveApiService.getBotSettings() : mockBackend.getBotSettings();
              setBotSettings(s);
          } catch(e) {}
      };
      if (activeTab === 'dashboard') loadSettings();
  }, [activeTab, dataSource, isAuthenticated]);

  useEffect(() => {
    if (isShowcaseMode || activePublicPage !== 'none' || !isAuthenticated) return; 
    let unsubscribe: () => void = () => {};
    const fetchData = async () => {
      if (dataSource === 'mock') {
         setDrivers(mockBackend.getDrivers());
         unsubscribe = mockBackend.subscribe(() => {
             setDrivers(mockBackend.getDrivers());
             if (selectedDriver) {
                const updated = mockBackend.getDriver(selectedDriver.id);
                if (updated) setSelectedDriver(updated);
             }
         });
      } else {
         try {
           const data = await liveApiService.getDrivers();
           setDrivers(data);
           unsubscribe = liveApiService.subscribeToUpdates((updatedDrivers) => {
               setDrivers(prevDrivers => {
                   const driverMap = new Map<string, Driver>(prevDrivers.map(d => [d.id, d]));
                   updatedDrivers.forEach(d => {
                       const existing = driverMap.get(d.id);
                       if (existing && existing.messages && existing.messages.length > 0 && (!d.messages || d.messages.length === 0)) {
                           d.messages = existing.messages;
                       }
                       driverMap.set(d.id, d);
                   });
                   return Array.from(driverMap.values()).sort((a, b) => b.lastMessageTime - a.lastMessageTime);
               });
           });
           addNotification({ type: 'info', title: 'Connected to Live Server', message: 'Delta-Sync Active' });
         } catch (e: any) {
             if (e.message !== "Unauthorized") {
                 addNotification({ type: 'warning', title: 'Connection Failed', message: 'Ensure server is running.' });
             }
         }
      }
    };
    fetchData();
    return () => unsubscribe();
  }, [dataSource, activeTab, isShowcaseMode, activePublicPage, isAuthenticated]); 

  const handleLoginSuccess = (token: string, user: any) => {
      setAuthToken(token);
      setUserProfile(user);
      setIsAuthenticated(true);
      if ("Notification" in window) Notification.requestPermission();
  };

  if (activePublicPage === 'privacy') return <PrivacyPolicy />;
  if (activePublicPage === 'terms') return <TermsOfService />;
  if (activePublicPage === 'deletion') return <DataDeletion />;
  if (isShowcaseMode) return <PublicShowcase folderName={showcaseToken} />;

  if (!isAuthenticated) {
      return (
          <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
              <Login onLoginSuccess={handleLoginSuccess} />
          </GoogleOAuthProvider>
      );
  }
  
  const handleSelectDriver = async (driver: Driver) => {
      setSelectedDriver(driver);
      if (dataSource === 'live' && (!driver.messages || driver.messages.length === 0)) {
          try {
              const messages = await liveApiService.getDriverMessages(driver.id);
              const updatedDriver = { ...driver, messages };
              setSelectedDriver(updatedDriver);
              setDrivers(prev => prev.map(d => d.id === driver.id ? updatedDriver : d));
          } catch(e) { console.error("Failed to fetch history"); }
      }
  };

  const addNotification = (notif: Omit<AppNotification, 'id'>) => {
    const newNotif = { ...notif, id: Date.now().toString() + Math.random() };
    setNotifications(prev => [newNotif, ...prev]);
    if (notif.title.includes('Incoming') || notif.title.includes('Call')) {
         if ("Notification" in window && Notification.permission === "granted") new Notification(notif.title, { body: notif.message });
         try { new Audio('https://codeskulptor-demos.commondatastorage.googleapis.com/pang/pop.mp3').play(); } catch(e) {}
    }
    setTimeout(() => { setNotifications(prev => prev.filter(n => n.id !== newNotif.id)); }, 5000);
  };

  const removeNotification = (id: string) => { setNotifications(prev => prev.filter(n => n.id !== id)); };

  const handleUpdateDriver = async (id: string, updates: Partial<Driver>) => {
    if (dataSource === 'mock') {
        if (updates.status) mockBackend.updateDriverStatus(id, updates.status);
        mockBackend.updateDriverDetails(id, updates);
    } else {
        try {
            await liveApiService.updateDriver(id, updates);
            const updated = drivers.map(d => d.id === id ? { ...d, ...updates } : d);
            setDrivers(updated);
            if (selectedDriver && selectedDriver.id === id) setSelectedDriver({ ...selectedDriver, ...updates });
        } catch (e) { alert("Failed to update driver details"); }
    }
  };
  
  const handleBulkStatusUpdate = async (ids: string[], status: LeadStatus) => {
      for (const id of ids) await handleUpdateDriver(id, { status });
      addNotification({ type: 'success', title: 'Bulk Update Complete', message: `Moved ${ids.length} leads to ${status}` });
  };

  const handleSendMessage = async (text: string) => {
    if (!selectedDriver) return;
    if (dataSource === 'mock') {
        mockBackend.addMessage(selectedDriver.id, { id: Date.now().toString(), sender: 'agent', text: text, timestamp: Date.now(), type: 'text' });
    } else {
        try {
            await liveApiService.sendMessage(selectedDriver.id, text);
            const msg: Message = { id: Date.now().toString(), sender: 'agent', text: text, timestamp: Date.now(), type: 'text', status: 'sent' };
            const updatedDriver = { ...selectedDriver, lastMessage: text, lastMessageTime: Date.now(), messages: [...(selectedDriver.messages || []), msg] };
            setSelectedDriver(updatedDriver);
            setDrivers(prev => prev.map(d => d.id === selectedDriver.id ? updatedDriver : d));
        } catch (e) { alert("Failed to send message via WhatsApp API"); }
    }
  };

  const handleSendWelcome = (driver: Driver) => {
    const welcomeVideoUrl = "https://your-s3-bucket.s3.amazonaws.com/welcome-video.mp4"; 
    if (dataSource === 'mock') {
        mockBackend.addMessage(driver.id, { id: Date.now().toString(), sender: 'system' as const, text: welcomeVideoUrl, timestamp: Date.now(), type: 'video_link' as const });
        addNotification({ type: 'success', title: 'Welcome Video Sent', message: `Onboarding initiated for ${driver.name}` });
    } else {
         handleSendMessage(welcomeVideoUrl);
         addNotification({ type: 'success', title: 'Welcome Video Sent', message: 'Video link sent via WhatsApp' });
    }
  };

  const handleBulkSendLegacy = () => {
    if (dataSource === 'mock') {
        selectedBulkIds.forEach(id => {
           mockBackend.addMessage(id, { id: Date.now().toString() + id, sender: 'system', text: '[Bulk Template]: Hello!', timestamp: Date.now(), type: 'template' as const });
        });
        setShowBulkModal(false);
        setSelectedBulkIds([]);
        addNotification({ type: 'success', title: 'Bulk Message Sent', message: `Sent to ${selectedBulkIds.length} drivers.` });
    } else {
        alert("Bulk Send not available in Read-Only Live Mode");
    }
  };
  
  const handleBulkSendDirect = async (ids: string[], message: string, mediaUrl?: string, mediaType?: string, options?: string[], templateName?: string, scheduledTime?: number) => {
      if (dataSource === 'mock') {
          ids.forEach(id => {
              mockBackend.addMessage(id, { id: Date.now().toString() + id, sender: 'agent', text: message, imageUrl: mediaUrl, options: options, timestamp: Date.now(), type: templateName ? 'template' : (mediaType ? (mediaType as any) : options ? 'options' : 'text'), templateName: templateName });
          });
      }
      
      // In LIVE mode, the LeadManager calls the API directly to queue messages on backend.
      // We just show the notification here.
      if (scheduledTime && scheduledTime > Date.now()) {
          addNotification({ type: 'success', title: 'Broadcast Scheduled', message: `Message queued for ${new Date(scheduledTime).toLocaleString()}` });
      } else {
          addNotification({ type: 'success', title: 'Broadcast Queued', message: `Processing ${ids.length} messages in background...` });
      }
  };

  const handleToggleRepeat = async () => {
      if (!botSettings || isRepeatToggling) return;
      setIsRepeatToggling(true);
      const newSettings = { ...botSettings, shouldRepeat: !botSettings.shouldRepeat };
      try {
          if (dataSource === 'live') await liveApiService.saveBotSettings(newSettings);
          else mockBackend.updateBotSettings(newSettings);
          setBotSettings(newSettings);
      } catch(e) { alert("Failed to toggle setting"); } finally { setIsRepeatToggling(false); }
  };

  const stats = {
    total: drivers.length,
    flagged: drivers.filter(d => d.status === LeadStatus.FLAGGED_FOR_REVIEW).length,
    qualified: drivers.filter(d => d.status === LeadStatus.QUALIFIED).length,
    new: drivers.filter(d => d.status === LeadStatus.NEW).length
  };

  return (
    <>
      <Layout activeTab={activeTab} onTabChange={setActiveTab} onOpenSettings={() => setShowSettingsModal(true)}>
        {activeTab === 'dashboard' && (
        <div className="p-8 max-w-7xl mx-auto space-y-8">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                 <div>
                    <h2 className="text-2xl font-bold text-gray-900">Dashboard</h2>
                    <p className="text-gray-500">Welcome back. Here is your fleet recruitment overview.</p>
                 </div>
                 <div className="flex items-center gap-2">
                   {botSettings && (
                       <button onClick={handleToggleRepeat} disabled={isRepeatToggling} className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-bold transition-all shadow-sm ${botSettings.shouldRepeat ? 'bg-purple-100 text-purple-700 border-purple-200 hover:bg-purple-200' : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'}`} title="Restart bot flow automatically">
                           <Repeat size={18} className={isRepeatToggling ? 'animate-spin' : ''} />
                           Bot Repeat: {botSettings.shouldRepeat ? 'ON' : 'OFF'}
                       </button>
                   )}
                   {dataSource === 'live' && (
                     <button onClick={() => setShowWebhookModal(true)} className="bg-white border border-gray-200 text-gray-700 p-2 rounded-lg hover:bg-gray-50 transition-colors shadow-sm"><SettingsIcon size={20} /></button>
                   )}
                   <div className="flex items-center bg-white border border-gray-200 rounded-lg p-1 shadow-sm">
                      <button onClick={() => changeDataSource('mock')} className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-2 ${dataSource === 'mock' ? 'bg-gray-100 text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}><Database size={16} /> Simulator</button>
                      <button onClick={() => changeDataSource('live')} className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-2 ${dataSource === 'live' ? 'bg-green-100 text-green-800 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}><Radio size={16} className={dataSource === 'live' ? 'animate-pulse' : ''} /> Live API</button>
                   </div>
                 </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                  <div className="flex items-center justify-between mb-4"><span className="text-gray-500 text-sm font-medium">Total Leads</span><div className="p-2 bg-blue-50 text-blue-600 rounded-lg"><Users size={20} /></div></div>
                  <div className="text-3xl font-bold text-gray-900">{stats.total}</div>
                </div>
                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                  <div className="flex items-center justify-between mb-4"><span className="text-gray-500 text-sm font-medium">Flagged Docs</span><div className="p-2 bg-amber-50 text-amber-600 rounded-lg"><FileText size={20} /></div></div>
                  <div className="text-3xl font-bold text-gray-900">{stats.flagged}</div>
                  <div className="text-xs text-amber-600 mt-2 font-medium">Needs Review</div>
                </div>
                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                  <div className="flex items-center justify-between mb-4"><span className="text-gray-500 text-sm font-medium">Qualified</span><div className="p-2 bg-green-50 text-green-600 rounded-lg"><CheckCircle size={20} /></div></div>
                  <div className="text-3xl font-bold text-gray-900">{stats.qualified}</div>
                </div>
                 <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                  <div className="flex items-center justify-between mb-4"><span className="text-gray-500 text-sm font-medium">New Leads</span><div className="p-2 bg-purple-50 text-purple-600 rounded-lg"><MessageSquare size={20} /></div></div>
                  <div className="text-3xl font-bold text-gray-900">{stats.new}</div>
                </div>
              </div>

          <div className="h-[600px] flex flex-col">
            <div className="flex justify-between items-center mb-4"><h3 className="text-lg font-bold text-gray-900">Recent Activity</h3></div>
            {dataSource === 'live' && drivers.length === 0 && <div className="bg-amber-50 text-amber-800 p-4 rounded-lg mb-4 border border-amber-200 text-sm"><strong>Note:</strong> Waiting for new leads via Live API.</div>}
            <LeadTable drivers={drivers} onSelectDriver={handleSelectDriver} onSendWelcome={handleSendWelcome} selectedIds={selectedBulkIds} onBulkSelect={setSelectedBulkIds} />
          </div>
        </div>
        )}
        
        {activeTab === 'leads' && <div className="p-4 h-screen bg-gray-50"><LeadManager drivers={drivers} onSelectDriver={handleSelectDriver} onBulkSend={handleBulkSendDirect} onUpdateDriverStatus={handleBulkStatusUpdate} /></div>}
        {activeTab === 'media-library' && <MediaLibrary />}
        {activeTab === 'bot-studio' && <BotBuilder isLiveMode={dataSource === 'live'} />}

        {showWebhookModal && <WebhookConfigModal onClose={() => setShowWebhookModal(false)} onSuccess={() => { addNotification({ type: 'success', title: 'Webhook Configured', message: 'Meta App settings updated successfully.' }); }} />}
        {showSettingsModal && <SettingsModal onClose={() => setShowSettingsModal(false)} />}
        {showBulkModal && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"><div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-md m-4"><h3 className="text-lg font-bold mb-4">Send Bulk Message</h3><div className="flex gap-3"><button onClick={() => setShowBulkModal(false)} className="flex-1 px-4 py-2 border rounded-lg">Cancel</button><button onClick={handleBulkSendLegacy} className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg">Send</button></div></div></div>}

        <ChatDrawer driver={selectedDriver} onClose={() => setSelectedDriver(null)} onSendMessage={handleSendMessage} onUpdateDriver={handleUpdateDriver} />
        {dataSource === 'live' && <AssistantChat />}
        {dataSource === 'live' && <SystemMonitor />}
        <NotificationToast notifications={notifications} onDismiss={removeNotification} />
      </Layout>
      {dataSource === 'mock' && <Simulator onNotify={addNotification} />}
    </>
  );
}
