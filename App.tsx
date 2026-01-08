
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
import { MediaLibrary } from './components/MediaLibrary';
import { PublicShowcase } from './components/PublicShowcase'; 
import { mockBackend } from './services/mockBackend';
import { liveApiService } from './services/liveApiService';
import { Lead, LeadStatus, AppNotification, BotSettings, Message, Company } from './types';
import { Users, FileText, CheckCircle, Send, MessageSquare, Database, Radio, Settings as SettingsIcon, Split, Bot } from 'lucide-react';

// DEFAULT MOCK COMPANY
const DEFAULT_MOCK_COMPANY: Company = {
    id: '1',
    name: 'Encho Cabs',
    type: 'logistics',
    terminology: { singular: 'Driver', plural: 'Drivers', field1Label: 'License Plate', field2Label: 'Availability' },
    themeColor: '#000000'
};

export default function App() {
  const [isShowcaseMode, setIsShowcaseMode] = useState(false);
  const [showcaseFolderName, setShowcaseFolderName] = useState<string | undefined>(undefined);

  // COMPANY STATE
  const [companies, setCompanies] = useState<Company[]>([DEFAULT_MOCK_COMPANY]);
  const [selectedCompany, setSelectedCompany] = useState<Company>(DEFAULT_MOCK_COMPANY);

  useEffect(() => {
      const path = window.location.pathname;
      if (path.startsWith('/showcase')) {
          setIsShowcaseMode(true);
          const parts = path.split('/showcase/');
          if (parts.length > 1 && parts[1].trim() !== '') {
              setShowcaseFolderName(decodeURIComponent(parts[1]));
          }
      }
      if ("Notification" in window) Notification.requestPermission();
  }, []);

  const [activeTab, setActiveTab] = useState('dashboard');
  const [leads, setLeads] = useState<Lead[]>([]); // Renamed from drivers
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [selectedBulkIds, setSelectedBulkIds] = useState<string[]>([]);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [showWebhookModal, setShowWebhookModal] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  
  const [dataSource, setDataSource] = useState<'mock' | 'live'>('mock');
  const [botSettings, setBotSettings] = useState<BotSettings | null>(null);

  // FETCH COMPANIES
  useEffect(() => {
      if (isShowcaseMode || dataSource === 'mock') return;
      
      const fetchCompanies = async () => {
          const comps = await liveApiService.getCompanies();
          if (comps.length > 0) {
              setCompanies(comps);
              // Set default if not set
              if (selectedCompany.id === '1' && comps[0].id !== '1') {
                  setSelectedCompany(comps[0]);
                  liveApiService.setCompanyId(comps[0].id);
              }
          }
      };
      fetchCompanies();
  }, [dataSource, isShowcaseMode]);

  const handleCompanyChange = (id: string) => {
      const comp = companies.find(c => c.id === id);
      if (comp) {
          setSelectedCompany(comp);
          liveApiService.setCompanyId(id);
          // Reset data for new view
          setLeads([]);
          setSelectedLead(null);
      }
  };

  // Sync with backend (Mock or Live)
  useEffect(() => {
    if (isShowcaseMode) return; 

    let unsubscribe: () => void = () => {};

    const fetchData = async () => {
      if (dataSource === 'mock') {
         setLeads(mockBackend.getDrivers() as unknown as Lead[]); // Cast for mock compat
         setBotSettings(mockBackend.getBotSettings());
         unsubscribe = mockBackend.subscribe(() => {
             setLeads(mockBackend.getDrivers() as unknown as Lead[]);
             setBotSettings(mockBackend.getBotSettings());
         });
      } else {
         // Live Mode
         try {
           const data = await liveApiService.getLeads();
           setLeads(data);
           const settings = await liveApiService.getBotSettings();
           setBotSettings(settings);

           unsubscribe = liveApiService.subscribeToUpdates(async () => {
               try {
                   const updated = await liveApiService.getLeads();
                   setLeads(updated);
               } catch (e) {}
           });
           
           addNotification({
             type: 'info',
             title: `Connected: ${selectedCompany.name}`,
             message: 'Live stream active.'
           });
         } catch (e) {
             console.error(e);
         }
      }
    };

    fetchData();
    return () => unsubscribe();
  }, [dataSource, activeTab, isShowcaseMode, selectedCompany.id]); 

  useEffect(() => {
    if (selectedLead && dataSource === 'live') {
      const updated = leads.find(d => d.id === selectedLead.id);
      if (updated && updated !== selectedLead) {
        setSelectedLead(updated);
      }
    }
  }, [leads, selectedLead, dataSource]);

  const addNotification = (notif: Omit<AppNotification, 'id'>) => {
    const newNotif = { ...notif, id: Date.now().toString() + Math.random() };
    setNotifications(prev => [newNotif, ...prev]);
    if (notif.title.includes('Incoming')) {
         try { new Audio('https://codeskulptor-demos.commondatastorage.googleapis.com/pang/pop.mp3').play(); } catch(e) {}
    }
    setTimeout(() => setNotifications(prev => prev.filter(n => n.id !== newNotif.id)), 5000);
  };

  const removeNotification = (id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  const handleUpdateLead = async (id: string, updates: Partial<Lead>) => {
    if (dataSource === 'mock') {
        mockBackend.updateDriverDetails(id, updates as any);
    } else {
        try {
            await liveApiService.updateLead(id, updates);
            const updated = leads.map(d => d.id === id ? { ...d, ...updates } : d);
            setLeads(updated);
            if (selectedLead && selectedLead.id === id) {
                setSelectedLead({ ...selectedLead, ...updates });
            }
        } catch (e) {
            alert("Update failed");
        }
    }
  };

  const handleSendMessage = async (text: string) => {
    if (!selectedLead) return;
    
    if (dataSource === 'mock') {
        mockBackend.addMessage(selectedLead.id, { id: Date.now().toString(), sender: 'agent', text, timestamp: Date.now(), type: 'text' });
    } else {
        try {
            await liveApiService.sendMessage(selectedLead.id, text);
            // Optimistic update handled by re-fetch usually, but for speed:
            const msg: Message = { id: Date.now().toString(), sender: 'agent', text, timestamp: Date.now(), type: 'text' };
            const updatedLead = { ...selectedLead, lastMessage: text, lastMessageTime: Date.now(), messages: [...selectedLead.messages, msg] };
            setSelectedLead(updatedLead);
            setLeads(prev => prev.map(d => d.id === selectedLead.id ? updatedLead : d));
        } catch (e) { alert("Failed to send"); }
    }
  };

  const handleSendWelcome = (lead: Lead) => {
    const welcomeVideoUrl = "https://your-s3-bucket.s3.amazonaws.com/welcome-video.mp4"; 
    if (dataSource === 'mock') {
        mockBackend.addMessage(lead.id, { id: Date.now().toString(), sender: 'system', text: welcomeVideoUrl, timestamp: Date.now(), type: 'video_link' });
    } else {
         handleSendMessage(welcomeVideoUrl);
    }
    addNotification({ type: 'success', title: 'Welcome Content Sent', message: `Sent to ${lead.name}` });
  };

  const handleStrategyChange = async (strategy: 'HYBRID_BOT_FIRST' | 'AI_ONLY' | 'BOT_ONLY') => {
      if (!botSettings) return;
      const newSettings = { ...botSettings, routingStrategy: strategy };
      setBotSettings(newSettings);
      if (dataSource === 'mock') mockBackend.updateBotSettings(newSettings);
      else await liveApiService.saveBotSettings(newSettings);
  };

  const stats = {
    total: leads.length,
    flagged: leads.filter(d => d.status === LeadStatus.FLAGGED_FOR_REVIEW).length,
    qualified: leads.filter(d => d.status === LeadStatus.QUALIFIED).length,
    new: leads.filter(d => d.status === LeadStatus.NEW).length
  };

  if (isShowcaseMode) return <PublicShowcase folderName={showcaseFolderName} />;

  return (
    <>
      <Layout 
        activeTab={activeTab} 
        onTabChange={setActiveTab}
        companies={companies}
        selectedCompany={selectedCompany}
        onCompanyChange={handleCompanyChange}
      >
        {(activeTab === 'dashboard' || activeTab === 'leads') && (
        <div className="p-8 max-w-7xl mx-auto space-y-8">
          {activeTab === 'dashboard' && (
            <>
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                 <div>
                    <h2 className="text-2xl font-bold text-gray-900">Dashboard</h2>
                    <p className="text-gray-500">Overview for {selectedCompany.name}</p>
                 </div>
                 
                 <div className="flex items-center gap-2">
                   {botSettings && (
                     <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg p-1 shadow-sm mr-2">
                         <button onClick={() => handleStrategyChange('HYBRID_BOT_FIRST')} className={`px-3 py-1.5 rounded text-xs font-bold flex items-center gap-1.5 ${botSettings.routingStrategy === 'HYBRID_BOT_FIRST' ? 'bg-blue-600 text-white' : 'text-gray-400'}`}><Split size={14} /> Hybrid</button>
                         <button onClick={() => handleStrategyChange('BOT_ONLY')} className={`px-3 py-1.5 rounded text-xs font-bold flex items-center gap-1.5 ${botSettings.routingStrategy === 'BOT_ONLY' ? 'bg-green-600 text-white' : 'text-gray-400'}`}><Bot size={14} /> Bot Only</button>
                         <button onClick={() => handleStrategyChange('AI_ONLY')} className={`px-3 py-1.5 rounded text-xs font-bold flex items-center gap-1.5 ${botSettings.routingStrategy === 'AI_ONLY' ? 'bg-purple-600 text-white' : 'text-gray-400'}`}><SettingsIcon size={14} /> AI Only</button>
                     </div>
                   )}
                   
                   <div className="flex items-center bg-white border border-gray-200 rounded-lg p-1 shadow-sm">
                      <button onClick={() => setDataSource('mock')} className={`px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-2 ${dataSource === 'mock' ? 'bg-gray-100 text-gray-900' : 'text-gray-500'}`}><Database size={16} /> Sim</button>
                      <button onClick={() => setDataSource('live')} className={`px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-2 ${dataSource === 'live' ? 'bg-green-100 text-green-800' : 'text-gray-500'}`}><Radio size={16} /> Live</button>
                   </div>
                 </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                  <span className="text-gray-500 text-sm font-medium">Total {selectedCompany.terminology.plural}</span>
                  <div className="text-3xl font-bold text-gray-900 mt-2">{stats.total}</div>
                </div>
                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                  <span className="text-gray-500 text-sm font-medium">Flagged</span>
                  <div className="text-3xl font-bold text-gray-900 mt-2">{stats.flagged}</div>
                </div>
                <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                  <span className="text-gray-500 text-sm font-medium">Qualified</span>
                  <div className="text-3xl font-bold text-gray-900 mt-2">{stats.qualified}</div>
                </div>
                 <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                  <span className="text-gray-500 text-sm font-medium">New</span>
                  <div className="text-3xl font-bold text-gray-900 mt-2">{stats.new}</div>
                </div>
              </div>
            </>
          )}

          <div className="h-[600px] flex flex-col">
            <h3 className="text-lg font-bold text-gray-900 mb-4">{selectedCompany.terminology.plural} Management</h3>
            <LeadTable 
              drivers={leads}
              onSelectDriver={setSelectedLead}
              onSendWelcome={handleSendWelcome}
              selectedIds={selectedBulkIds}
              onBulkSelect={setSelectedBulkIds}
            />
          </div>
        </div>
        )}

        {activeTab === 'media-library' && <MediaLibrary />}
        {activeTab === 'bot-studio' && <BotBuilder isLiveMode={dataSource === 'live'} />}
        {activeTab === 'ai-training' && <AITraining isLiveMode={dataSource === 'live'} />}

        {showWebhookModal && <WebhookConfigModal onClose={() => setShowWebhookModal(false)} onSuccess={() => addNotification({ type: 'success', title: 'Webhook Configured', message: 'Success' })} />}

        <ChatDrawer 
          driver={selectedLead} 
          onClose={() => setSelectedLead(null)}
          onSendMessage={handleSendMessage}
          onUpdateDriver={handleUpdateLead}
        />
        
        {dataSource === 'live' && <AssistantChat />}
        <NotificationToast notifications={notifications} onDismiss={removeNotification} />
      </Layout>
      
      {dataSource === 'mock' && <Simulator onNotify={addNotification} />}
    </>
  );
}
