
import React, { useState } from 'react';
import { 
  LayoutDashboard, 
  MessageSquare, 
  Settings, 
  LogOut, 
  Users,
  Bot,
  Cloud,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';

interface LayoutProps {
  children: React.ReactNode;
  activeTab: string;
  onTabChange: (tab: string) => void;
  onOpenSettings?: () => void;
}

export const Layout: React.FC<LayoutProps> = ({ children, activeTab, onTabChange, onOpenSettings }) => {
  const [isCollapsed, setIsCollapsed] = useState(false);

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Sidebar */}
      <aside 
        className={`${
          isCollapsed ? 'w-20' : 'w-64'
        } bg-black text-white flex flex-col shadow-xl z-20 transition-all duration-300 ease-in-out relative shrink-0`}
      >
        {/* Toggle Button */}
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="absolute -right-3 top-9 bg-blue-600 text-white p-1 rounded-full shadow-lg hover:bg-blue-700 transition-colors z-50 border border-black"
          title={isCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
        >
          {isCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>

        {/* Header */}
        <div className={`p-6 border-b border-gray-800 flex items-center gap-3 ${isCollapsed ? 'justify-center px-2' : ''} overflow-hidden`}>
          <div className="bg-white text-black p-2 rounded-lg flex items-center justify-center shrink-0">
            {/* Black WhatsApp Logo SVG */}
            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" className="text-black">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
            </svg>
          </div>
          <div className={`transition-opacity duration-300 ${isCollapsed ? 'opacity-0 w-0 hidden' : 'opacity-100'}`}>
            <h1 className="font-bold text-lg tracking-tight whitespace-nowrap">Encho WhatsApp</h1>
            <p className="text-xs text-gray-400 whitespace-nowrap">Handler</p>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-2 overflow-y-auto overflow-x-hidden">
          <button
            onClick={() => onTabChange('dashboard')}
            title={isCollapsed ? "Dashboard" : ""}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
              activeTab === 'dashboard' 
                ? 'bg-white text-black font-medium' 
                : 'text-gray-400 hover:bg-gray-900 hover:text-white'
            } ${isCollapsed ? 'justify-center px-2' : ''}`}
          >
            <LayoutDashboard size={20} className="shrink-0" />
            <span className={`transition-all duration-200 ${isCollapsed ? 'w-0 opacity-0 hidden' : 'w-auto opacity-100'}`}>Dashboard</span>
          </button>
          
          <button
            onClick={() => onTabChange('leads')}
            title={isCollapsed ? "Leads & Campaigns" : ""}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
              activeTab === 'leads' 
                ? 'bg-white text-black font-medium' 
                : 'text-gray-400 hover:bg-gray-900 hover:text-white'
            } ${isCollapsed ? 'justify-center px-2' : ''}`}
          >
            <Users size={20} className="shrink-0" />
            <span className={`transition-all duration-200 ${isCollapsed ? 'w-0 opacity-0 hidden' : 'w-auto opacity-100'}`}>Leads & Campaigns</span>
          </button>

          <button
            onClick={() => onTabChange('media-library')}
            title={isCollapsed ? "Media Library" : ""}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
              activeTab === 'media-library' 
                ? 'bg-white text-black font-medium' 
                : 'text-gray-400 hover:bg-gray-900 hover:text-white'
            } ${isCollapsed ? 'justify-center px-2' : ''}`}
          >
            <Cloud size={20} className="shrink-0" />
            <span className={`transition-all duration-200 ${isCollapsed ? 'w-0 opacity-0 hidden' : 'w-auto opacity-100'}`}>Media Library (S3)</span>
          </button>
          
          <div className={`pt-4 pb-2 transition-all duration-200 ${isCollapsed ? 'border-t border-gray-800 mt-2 pt-2' : ''}`}>
            {!isCollapsed ? (
              <p className="px-4 text-[10px] font-bold text-gray-500 uppercase tracking-wider whitespace-nowrap">Automation</p>
            ) : (
              <div className="h-px w-8 mx-auto bg-gray-800" />
            )}
          </div>

          <button
            onClick={() => onTabChange('bot-studio')}
            title={isCollapsed ? "Bot Studio" : ""}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
              activeTab === 'bot-studio' 
                ? 'bg-white text-black font-medium' 
                : 'text-gray-400 hover:bg-gray-900 hover:text-white'
            } ${isCollapsed ? 'justify-center px-2' : ''}`}
          >
            <Bot size={20} className="shrink-0" />
            <span className={`transition-all duration-200 ${isCollapsed ? 'w-0 opacity-0 hidden' : 'w-auto opacity-100'}`}>Bot Studio</span>
          </button>
        </nav>

        <div className="p-4 border-t border-gray-800">
          <button 
            onClick={onOpenSettings}
            title={isCollapsed ? "Settings" : ""}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-gray-400 hover:bg-gray-900 hover:text-white transition-all ${isCollapsed ? 'justify-center px-2' : ''}`}
          >
            <Settings size={20} className="shrink-0" />
            <span className={`transition-all duration-200 ${isCollapsed ? 'w-0 opacity-0 hidden' : 'w-auto opacity-100'}`}>Settings</span>
          </button>
          <button 
            title={isCollapsed ? "Logout" : ""}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-red-400 hover:bg-gray-900 hover:text-red-300 transition-all mt-2 ${isCollapsed ? 'justify-center px-2' : ''}`}
          >
            <LogOut size={20} className="shrink-0" />
            <span className={`transition-all duration-200 ${isCollapsed ? 'w-0 opacity-0 hidden' : 'w-auto opacity-100'}`}>Logout</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto relative w-full">
        {children}
      </main>
    </div>
  );
};
