
import React, { lazy, Suspense, useState, useEffect } from 'react';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { Layout } from './components/Layout.tsx';
import { LeadTable } from './components/LeadTable.tsx';
import { LeadManager } from './components/LeadManager.tsx';
import { ChatDrawer } from './components/ChatDrawer.tsx';
import { Simulator } from './components/Simulator.tsx';
import { WebhookConfigModal } from './components/WebhookConfigModal.tsx';
import { NotificationToast } from './components/NotificationToast.tsx';
import { BotBuilder } from './components/BotBuilder.tsx';
import { AssistantChat } from './components/AssistantChat.tsx';
import { MediaLibrary } from './components/MediaLibrary.tsx';
import { PublicShowcase } from './components/PublicShowcase.tsx'; 
import { PrivacyPolicy } from './components/PrivacyPolicy.tsx'; 
import { TermsOfService } from './components/TermsOfService.tsx'; 
import { DataDeletion } from './components/DataDeletion.tsx'; 
import { SystemMonitor } from './components/SystemMonitor.tsx'; 
import { IsolatedFeatureBoundary } from './components/IsolatedFeatureBoundary.tsx'; 
import { SettingsModal } from './components/SettingsModal.tsx'; 
import { Login } from './components/Login.tsx'; 
import { StaffPortal } from './components/StaffPortal.tsx';
import { StaffManagement } from './components/StaffManagement.tsx';
import { ScheduledAlertPopup } from './components/ScheduledAlertPopup.tsx';
import { mockBackend } from './services/mockBackend.ts';
import { liveApiService, setAuthToken, UpdateConnectionState, DueAlertItem } from './services/liveApiService.ts';
import { reportUiFailure, reportUiRecovery } from './services/uiFailureMonitor.ts';
import { Driver, LeadStatus, AppNotification, BotSettings, Message } from './types.ts';
import { Users, FileText, CheckCircle, Send, MessageSquare, Database, Radio, Settings as SettingsIcon, Repeat, AlertTriangle, Wifi, WifiOff, Loader2 } from 'lucide-react';

const FALLBACK_CLIENT_ID = "764842119656-ufuaijbp0kb4m0ql6tjhdmmr3hr24t15.apps.googleusercontent.com";
const ENV_CLIENT_ID = (import.meta as any)?.env?.VITE_GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_ID = (ENV_CLIENT_ID || FALLBACK_CLIENT_ID).replace(/^['"]|['"]$/g, '').trim();
const DriverExcelReport = lazy(() => import('./components/DriverExcelReport.tsx').then((module) => ({ default: module.DriverExcelReport })));
const getDueAlertInstanceId = (alert: DueAlertItem) => `${alert.event_id}:${new Date(alert.scheduled_at).toISOString()}`;

export default function App() {
  const [isShowcaseMode, setIsShowcaseMode] = useState(false);
  const [activePublicPage, setActivePublicPage] = useState<'none' | 'privacy' | 'terms' | 'deletion'>('none');
  const [showcaseToken, setShowcaseToken] = useState<string | undefined>(undefined);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userProfile, setUserProfile] = useState<any>(null);
  
  const [isEmergencyMode, setIsEmergencyMode] = useState(false); // NEW: Recovery State

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
      if (token) { 
          setAuthToken(token); 
          setIsAuthenticated(true); 
          liveApiService.getProfile()
            .then(res => {
                if (res.success) setUserProfile(res.user);
            })
            .catch(() => {
                localStorage.removeItem('uber_fleet_auth_token');
                setIsAuthenticated(false);
            });
      }
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
  const [updateConnectionState, setUpdateConnectionState] = useState<UpdateConnectionState>('disconnected');
  const [syncFailureMetrics, setSyncFailureMetrics] = useState({ polling: 0, push: 0, lastEndpoint: 'n/a' });
  const [dueAlertQueue, setDueAlertQueue] = useState<DueAlertItem[]>([]);
  const [activeDueAlert, setActiveDueAlert] = useState<DueAlertItem | null>(null);
  const [shadowUser, setShadowUser] = useState<any>(null);
  
  const [dataSource, setDataSource] = useState<'mock' | 'live'>(() => {
      const saved = localStorage.getItem('uber_fleet_data_source');
      if (saved === 'live' || saved === 'mock') return saved;
      return process.env.NODE_ENV === 'production' ? 'live' : 'mock';
  });

  useEffect(() => {
      if (!isAuthenticated || !userProfile) return;

      let idleTimer: any;
      let heartbeatInterval: any;
      let isIdle = false;

      const resetIdle = () => {
          isIdle = false;
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => { isIdle = true; }, 10 * 60 * 1000); // 10 mins idle
      };

      window.addEventListener('mousemove', resetIdle);
      window.addEventListener('keydown', resetIdle);
      window.addEventListener('scroll', resetIdle);
      window.addEventListener('click', resetIdle);
      resetIdle();

      const sendBeat = () => {
          liveApiService.sendHeartbeat(isIdle ? 'idle' : 'online').catch(() => {});
      };

      sendBeat(); // Initial beat
      heartbeatInterval = setInterval(sendBeat, 60 * 1000); // Every 60s

      return () => {
          window.removeEventListener('mousemove', resetIdle);
          window.removeEventListener('keydown', resetIdle);
          window.removeEventListener('scroll', resetIdle);
          window.removeEventListener('click', resetIdle);
          clearTimeout(idleTimer);
          clearInterval(heartbeatInterval);
      };
  }, [isAuthenticated, userProfile]);

  useEffect(() => {
      if (dataSource !== 'live' || !isAuthenticated || isEmergencyMode) return;

      let failedAttempts = 0;
      const triggerCron = async () => {
          try {
              const response = await fetch('/api/cron/process-queue', {
                  headers: { 'Authorization': `Bearer ${localStorage.getItem('uber_fleet_auth_token')}` }
              });

              if (!response.ok) {
                  failedAttempts += 1;
                  if (failedAttempts >= 3) {
                      console.warn('[Cron Heartbeat] queue processor unhealthy', response.status);
                  }
                  return;
              }

              reportUiRecovery('polling', '/api/cron/process-queue');
              failedAttempts = 0;
          } catch(e) {
              const streak = reportUiFailure({
                channel: 'polling',
                endpoint: '/api/cron/process-queue',
                error: e,
                notifyUser: (message) => addNotification({ type: 'warning', title: 'Queue Heartbeat Degraded', message }),
                notifyAdmin: (message) => console.warn('[admin.notify]', message)
              });
              failedAttempts = streak;
          }
      };

      const interval = setInterval(triggerCron, 10000);
      triggerCron();
      return () => clearInterval(interval);
  }, [dataSource, isAuthenticated, isEmergencyMode]);

  const changeDataSource = (mode: 'mock' | 'live') => {
      setDataSource(mode);
      localStorage.setItem('uber_fleet_data_source', mode);
  };

  useEffect(() => {
      if (!isAuthenticated || isEmergencyMode) return;
      const loadSettings = async () => {
          try {
              const s = dataSource === 'live' ? await liveApiService.getBotSettings() : mockBackend.getBotSettings();
              setBotSettings(s);
          } catch(e) {
              reportUiFailure({
                channel: 'ui',
                endpoint: '/api/bot/settings',
                error: e,
                notifyUser: (message) => addNotification({ type: 'warning', title: 'Bot Settings Unavailable', message }),
                notifyAdmin: (message) => console.warn('[admin.notify]', message)
              });
          }
      };
      if (activeTab === 'dashboard') loadSettings();
  }, [activeTab, dataSource, isAuthenticated, isEmergencyMode]);

  useEffect(() => {
    if (isShowcaseMode || activePublicPage !== 'none' || !isAuthenticated || isEmergencyMode) return; 
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
           }, {
               onConnectionStateChange: setUpdateConnectionState,
               onSyncFailure: ({ channel, endpoint, streak, error }) => {
                 const failureStreak = reportUiFailure({
                   channel,
                   endpoint,
                   error,
                   notifyUser: (message) => addNotification({ type: 'warning', title: 'Live Sync Degraded', message }),
                   notifyAdmin: (message) => console.warn('[admin.notify]', message)
                 });
                 setSyncFailureMetrics(prev => ({ ...prev, [channel]: failureStreak, lastEndpoint: endpoint }));
               },
               onSyncRecovery: ({ channel, endpoint }) => {
                 reportUiRecovery(channel, endpoint);
                 setSyncFailureMetrics(prev => ({ ...prev, [channel]: 0, lastEndpoint: endpoint }));
               }
           });
           addNotification({ type: 'info', title: 'Connected to Live Server', message: 'Delta-Sync Active' });
         } catch (e: any) {
             if (e.message.includes('relation') && e.message.includes('does not exist')) {
                 setIsEmergencyMode(true); // TRIGGER EMERGENCY MODE
             } else if (e.message !== "Unauthorized") {
                 addNotification({ type: 'warning', title: 'Connection Failed', message: 'Ensure server is running.' });
             }
         }
      }
    };
    fetchData();
    return () => {
      setUpdateConnectionState('disconnected');
      unsubscribe();
    };
  }, [dataSource, activeTab, isShowcaseMode, activePublicPage, isAuthenticated, isEmergencyMode]); 

  const handleLoginSuccess = (token: string, user: any) => {
      setAuthToken(token);
      setUserProfile(user);
      setIsAuthenticated(true);
      if ("Notification" in window) Notification.requestPermission();
  };

  useEffect(() => {
      if (!isAuthenticated || dataSource !== 'live' || !userProfile) return;
      if (userProfile.role !== 'admin') return;

      const seenKey = `due_alerts_seen:${userProfile.staffId || userProfile.email || userProfile.role}`;
      const readSeenIds = () => new Set<string>(JSON.parse(localStorage.getItem(seenKey) || '[]'));

      const syncDueAlerts = async () => {
          try {
              const alerts = await liveApiService.getDueAlerts();
              const seenIds = readSeenIds();
              const fresh = alerts.filter((item) => {
                  const instanceId = getDueAlertInstanceId(item);
                  return !seenIds.has(instanceId);
              });
              if (fresh.length > 0) {
                  setDueAlertQueue(prev => {
                      const existing = new Set(prev.map(entry => getDueAlertInstanceId(entry)));
                      if (activeDueAlert?.event_id) {
                          existing.add(getDueAlertInstanceId(activeDueAlert));
                      }
                      return [...prev, ...fresh.filter(entry => !existing.has(getDueAlertInstanceId(entry)))];
                  });
              }
          } catch (e) {
              console.error('Failed to fetch due alerts', e);
          }
      };

      syncDueAlerts();
      const timer = setInterval(syncDueAlerts, 30000);
      return () => clearInterval(timer);
  }, [isAuthenticated, dataSource, userProfile, activeDueAlert?.event_id]);

  useEffect(() => {
      if (activeDueAlert || dueAlertQueue.length === 0) return;
      const next = dueAlertQueue[0];
      setActiveDueAlert(next);
      setDueAlertQueue(prev => prev.slice(1));
      if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(`Lead Alert: ${next.lead_name}`, {
              body: `Scheduled time reached at ${new Date(next.scheduled_at).toLocaleString()}`
          });
      }
  }, [dueAlertQueue, activeDueAlert]);

  const dismissDueAlert = (eventId?: string) => {
      if (!eventId || !userProfile) {
          setActiveDueAlert(null);
          return;
      }
      const seenKey = `due_alerts_seen:${userProfile.staffId || userProfile.email || userProfile.role}`;
      const seenIds = new Set<string>(JSON.parse(localStorage.getItem(seenKey) || '[]'));
      if (activeDueAlert && activeDueAlert.event_id === eventId) {
          seenIds.add(getDueAlertInstanceId(activeDueAlert));
      }
      localStorage.setItem(seenKey, JSON.stringify(Array.from(seenIds)));
      setDueAlertQueue(prev => prev.filter(alert => {
          if (activeDueAlert && activeDueAlert.event_id === eventId) {
              return getDueAlertInstanceId(alert) !== getDueAlertInstanceId(activeDueAlert);
          }
          return alert.event_id !== eventId;
      }));
      setActiveDueAlert(null);
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

  // --- SHADOW MODE VIEW ---
  if (shadowUser) {
      return (
          <div className="relative h-screen w-full flex flex-col">
              <div className="bg-purple-600 text-white px-4 py-2 flex justify-between items-center shadow-md z-50">
                  <div className="flex items-center gap-2 font-bold">
                      <span className="animate-pulse">👁️</span>
                      SHADOW MODE ACTIVE: You are viewing {shadowUser.name}'s workspace
                  </div>
                  <button 
                      onClick={() => setShadowUser(null)}
                      className="bg-white text-purple-700 px-4 py-1 rounded-md font-bold hover:bg-purple-100 transition-colors text-sm"
                  >
                      Exit Shadow Mode
                  </button>
              </div>
              <div className="flex-1 overflow-hidden">
                  <StaffPortal 
                      user={shadowUser} 
                      onLogout={() => setShadowUser(null)} 
                  />
              </div>
          </div>
      );
  }

  // --- STAFF / MANAGER PORTAL VIEW ---
  if (userProfile?.role === 'staff' || userProfile?.role === 'manager') {
      return (
          <StaffPortal 
              user={userProfile} 
              onLogout={() => {
                  localStorage.removeItem('uber_fleet_auth_token');
                  setIsAuthenticated(false);
                  setUserProfile(null);
              }} 
          />
      );
  }

  // --- EMERGENCY RECOVERY VIEW ---
  if (isEmergencyMode) {
      return (
          <div className="h-screen bg-gray-900 flex flex-col items-center justify-center p-8 relative overflow-hidden">
              <div className="absolute inset-0 bg-red-900/10 z-0 animate-pulse"></div>
              <div className="z-10 bg-white rounded-2xl shadow-2xl max-w-2xl w-full p-8 text-center border-t-8 border-red-600">
                  <div className="mx-auto w-20 h-20 bg-red-100 rounded-full flex items-center justify-center mb-6">
                      <AlertTriangle size={40} className="text-red-600" />
                  </div>
                  <h1 className="text-3xl font-black text-gray-900 mb-2">CRITICAL DATABASE ERROR</h1>
                  <p className="text-lg text-gray-600 mb-8">
                      The system connected to the database but could not find the required tables. <br/>
                      This usually happens after a "Hard Reset" where tables were dropped but not recreated.
                  </p>
                  
                  <div className="bg-gray-50 p-6 rounded-xl border-2 border-dashed border-gray-300 mb-8">
                      <h3 className="font-bold text-gray-800 flex items-center justify-center gap-2 mb-4">
                          <Database size={20} /> System Diagnostics Active
                      </h3>
                      {/* Embed SystemMonitor Logic Here or just show it */}
                      <p className="text-sm text-gray-500 mb-4">Please use the tool below to rebuild the schema.</p>
                  </div>

                  <button 
                    onClick={() => window.location.reload()} 
                    className="bg-gray-800 text-white px-6 py-3 rounded-lg font-bold hover:bg-black transition-all shadow-lg"
                  >
                    Reload Application
                  </button>
              </div>
              {/* Force SystemMonitor to show */}
              <SystemMonitor />
          </div>
      );
  }
  
  // ... (Rest of App Logic)
  
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
         try { new Audio('https://codeskulptor-demos.commondatastorage.googleapis.com/pang/pop.mp3').play(); } catch(e) {
           reportUiFailure({
             channel: 'ui',
             endpoint: 'audio://notification-pop',
             error: e,
             notifyAdmin: (message) => console.warn('[admin.notify]', message)
           });
         }
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

  const handleSendMessage = async (text: string, options?: { mediaUrl?: string, mediaType?: string }) => {
    if (!selectedDriver) return;
    if (dataSource === 'mock') {
        const msg: Message = { 
            id: Date.now().toString(), 
            sender: 'agent', 
            text: text, 
            timestamp: Date.now(), 
            type: options?.mediaType as any || 'text',
            imageUrl: options?.mediaType === 'image' ? options.mediaUrl : undefined,
            videoUrl: options?.mediaType === 'video' ? options.mediaUrl : undefined,
            audioUrl: options?.mediaType === 'audio' ? options.mediaUrl : undefined,
            documentUrl: options?.mediaType === 'document' ? options.mediaUrl : undefined
        };
        mockBackend.addMessage(selectedDriver.id, msg);
    } else {
        try {
            await liveApiService.sendMessage(selectedDriver.id, text, options);
            const msg: Message = { 
                id: Date.now().toString(), 
                sender: 'agent', 
                text: text, 
                timestamp: Date.now(), 
                type: options?.mediaType as any || 'text', 
                status: 'sent',
                imageUrl: options?.mediaType === 'image' ? options.mediaUrl : undefined,
                videoUrl: options?.mediaType === 'video' ? options.mediaUrl : undefined,
                audioUrl: options?.mediaType === 'audio' ? options.mediaUrl : undefined,
                documentUrl: options?.mediaType === 'document' ? options.mediaUrl : undefined
            };
            const updatedDriver = { ...selectedDriver, lastMessage: text || `[${options?.mediaType?.toUpperCase()}]`, lastMessageTime: Date.now(), messages: [...(selectedDriver.messages || []), msg] };
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


  const renderConnectionHealth = () => {
    if (dataSource !== 'live') return null;
    const isHealthy = updateConnectionState === 'connected';
    const labelMap: Record<UpdateConnectionState, string> = {
      connecting: 'Connecting…',
      connected: 'Live Push',
      reconnecting: 'Reconnecting…',
      polling: 'Polling Fallback',
      disconnected: 'Disconnected'
    };

    return (
      <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold ${isHealthy ? 'bg-green-50 border-green-200 text-green-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>
        {updateConnectionState === 'connecting' || updateConnectionState === 'reconnecting' ? <Loader2 size={14} className="animate-spin" /> : isHealthy ? <Wifi size={14} /> : <WifiOff size={14} />}
        <span>{labelMap[updateConnectionState]}</span>
      </div>
    );
  };

  const stats = {
    total: drivers.length,
    flagged: drivers.filter(d => d.status === LeadStatus.FLAGGED_FOR_REVIEW).length,
    qualified: drivers.filter(d => d.status === LeadStatus.QUALIFIED).length,
    new: drivers.filter(d => d.status === LeadStatus.NEW).length
  };

  return (
    <>
      <Layout 
        activeTab={activeTab} 
        onTabChange={setActiveTab} 
        onOpenSettings={() => setShowSettingsModal(true)}
        userRole={userProfile?.role}
      >
        {activeTab === 'dashboard' && (
        <div className="p-8 max-w-7xl mx-auto space-y-8">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                 <div>
                    <h2 className="text-2xl font-bold text-gray-900">Dashboard</h2>
                    <p className="text-gray-500">Welcome back. Here is your fleet recruitment overview.</p>
                 </div>
                 <div className="flex items-center gap-2">
                   {renderConnectionHealth()}
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

              <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
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
                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                  <div className="flex items-center justify-between mb-4"><span className="text-gray-500 text-sm font-medium">Sync Failures</span><div className="p-2 bg-rose-50 text-rose-600 rounded-lg"><AlertTriangle size={20} /></div></div>
                  <div className="text-2xl font-bold text-gray-900">P:{syncFailureMetrics.push} · F:{syncFailureMetrics.polling}</div>
                  <div className="text-xs text-rose-600 mt-2 font-medium truncate" title={syncFailureMetrics.lastEndpoint}>Last: {syncFailureMetrics.lastEndpoint}</div>
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
        {activeTab === 'excel-report' && (
          <IsolatedFeatureBoundary featureName="Driver Excel Report">
            <Suspense fallback={<div className="p-8 text-gray-500">Loading Driver Excel Report...</div>}>
              <DriverExcelReport isLiveMode={dataSource === 'live'} />
            </Suspense>
          </IsolatedFeatureBoundary>
        )}
        {activeTab === 'media-library' && <MediaLibrary />}
        {activeTab === 'bot-studio' && <BotBuilder isLiveMode={dataSource === 'live'} />}
        {activeTab === 'staff' && <StaffManagement onShadowUser={setShadowUser} />}

        {showWebhookModal && <WebhookConfigModal onClose={() => setShowWebhookModal(false)} onSuccess={() => { addNotification({ type: 'success', title: 'Webhook Configured', message: 'Meta App settings updated successfully.' }); }} />}
        {showSettingsModal && <SettingsModal onClose={() => setShowSettingsModal(false)} />}
        {showBulkModal && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"><div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-md m-4"><h3 className="text-lg font-bold mb-4">Send Bulk Message</h3><div className="flex gap-3"><button onClick={() => setShowBulkModal(false)} className="flex-1 px-4 py-2 border rounded-lg">Cancel</button><button onClick={handleBulkSendLegacy} className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg">Send</button></div></div></div>}

        <ChatDrawer 
          driver={selectedDriver} 
          onClose={() => setSelectedDriver(null)} 
          onSendMessage={handleSendMessage} 
          onUpdateDriver={handleUpdateDriver} 
          updateConnectionState={updateConnectionState} 
          userName={userProfile?.name}
          botSettings={botSettings}
        />
        {dataSource === 'live' && <AssistantChat />}
        {dataSource === 'live' && <SystemMonitor />}
        <NotificationToast notifications={notifications} onDismiss={removeNotification} />
        <ScheduledAlertPopup
          alert={activeDueAlert}
          onDismiss={() => dismissDueAlert(activeDueAlert?.event_id)}
          onOpenLead={(leadId) => {
            setActiveTab('leads');
            const lead = drivers.find(d => d.id === leadId);
            if (lead) setSelectedDriver(lead);
          }}
        />
      </Layout>
      {dataSource === 'mock' && <Simulator onNotify={addNotification} />}
    </>
  );
}
