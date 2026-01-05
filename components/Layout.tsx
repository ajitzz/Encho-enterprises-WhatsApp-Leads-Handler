import React from 'react';
import { 
  LayoutDashboard, 
  MessageSquare, 
  Settings, 
  LogOut, 
  Car,
  Users
} from 'lucide-react';

interface LayoutProps {
  children: React.ReactNode;
  activeTab: string;
  onTabChange: (tab: string) => void;
}

export const Layout: React.FC<LayoutProps> = ({ children, activeTab, onTabChange }) => {
  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 bg-black text-white flex flex-col shadow-xl z-20">
        <div className="p-6 border-b border-gray-800 flex items-center gap-3">
          <div className="bg-white text-black p-2 rounded-lg">
            <Car size={24} />
          </div>
          <div>
            <h1 className="font-bold text-lg tracking-tight">Uber Fleet</h1>
            <p className="text-xs text-gray-400">Recruitment Portal</p>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-2">
          <button
            onClick={() => onTabChange('dashboard')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
              activeTab === 'dashboard' 
                ? 'bg-white text-black font-medium' 
                : 'text-gray-400 hover:bg-gray-900 hover:text-white'
            }`}
          >
            <LayoutDashboard size={20} />
            Dashboard
          </button>
          
          <button
            onClick={() => onTabChange('leads')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
              activeTab === 'leads' 
                ? 'bg-white text-black font-medium' 
                : 'text-gray-400 hover:bg-gray-900 hover:text-white'
            }`}
          >
            <Users size={20} />
            Lead Management
          </button>
        </nav>

        <div className="p-4 border-t border-gray-800">
          <button className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-gray-400 hover:bg-gray-900 hover:text-white transition-colors">
            <Settings size={20} />
            Settings
          </button>
          <button className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-red-400 hover:bg-gray-900 hover:text-red-300 transition-colors mt-2">
            <LogOut size={20} />
            Logout
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto relative">
        {children}
      </main>
    </div>
  );
};