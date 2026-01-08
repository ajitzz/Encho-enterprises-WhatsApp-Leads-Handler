
import React from 'react';
import { 
  LayoutDashboard, 
  Settings, 
  LogOut, 
  Users,
  Bot,
  Sparkles,
  Cloud,
  ChevronDown,
  Building2
} from 'lucide-react';
import { Company } from '../types';

interface LayoutProps {
  children: React.ReactNode;
  activeTab: string;
  onTabChange: (tab: string) => void;
  companies: Company[];
  selectedCompany: Company;
  onCompanyChange: (companyId: string) => void;
}

export const Layout: React.FC<LayoutProps> = ({ 
  children, 
  activeTab, 
  onTabChange, 
  companies, 
  selectedCompany, 
  onCompanyChange 
}) => {
  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 bg-black text-white flex flex-col shadow-xl z-20 transition-all duration-300">
        
        {/* Company Switcher */}
        <div className="p-4 border-b border-gray-800">
            <div className="relative group">
                <button className="w-full flex items-center justify-between bg-gray-900 p-3 rounded-xl border border-gray-800 hover:border-gray-700 transition-all">
                    <div className="flex items-center gap-3">
                        <div className="bg-white text-black p-1.5 rounded-lg">
                            <Building2 size={18} />
                        </div>
                        <div className="text-left">
                            <h1 className="font-bold text-sm tracking-tight">{selectedCompany.name}</h1>
                            <p className="text-[10px] text-gray-400 capitalize">{selectedCompany.type} Solution</p>
                        </div>
                    </div>
                    <ChevronDown size={14} className="text-gray-500 group-hover:text-white" />
                </button>
                
                {/* Dropdown Menu */}
                <div className="absolute top-full left-0 w-full mt-2 bg-gray-900 border border-gray-800 rounded-xl shadow-2xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 overflow-hidden">
                    {companies.map(c => (
                        <button 
                            key={c.id}
                            onClick={() => onCompanyChange(c.id)}
                            className={`w-full text-left px-4 py-3 text-sm flex items-center gap-2 hover:bg-gray-800 ${c.id === selectedCompany.id ? 'text-white bg-gray-800' : 'text-gray-400'}`}
                        >
                            <div className={`w-2 h-2 rounded-full ${c.id === selectedCompany.id ? 'bg-green-500' : 'bg-gray-600'}`} />
                            {c.name}
                        </button>
                    ))}
                </div>
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
            {selectedCompany.terminology.plural}
          </button>

          <button
            onClick={() => onTabChange('media-library')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
              activeTab === 'media-library' 
                ? 'bg-white text-black font-medium' 
                : 'text-gray-400 hover:bg-gray-900 hover:text-white'
            }`}
          >
            <Cloud size={20} />
            Media & Plans
          </button>
          
          <div className="pt-4 pb-2">
            <p className="px-4 text-[10px] font-bold text-gray-500 uppercase tracking-wider">Automation</p>
          </div>

          <button
            onClick={() => onTabChange('bot-studio')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
              activeTab === 'bot-studio' 
                ? 'bg-white text-black font-medium' 
                : 'text-gray-400 hover:bg-gray-900 hover:text-white'
            }`}
          >
            <Bot size={20} />
            Bot Studio
          </button>

          <button
            onClick={() => onTabChange('ai-training')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
              activeTab === 'ai-training' 
                ? 'bg-white text-black font-medium' 
                : 'text-gray-400 hover:bg-gray-900 hover:text-white'
            }`}
          >
            <Sparkles size={20} />
            AI Persona
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
        {/* Dynamic Top Banner for Company Context */}
        <div className="sticky top-0 z-10 bg-white border-b border-gray-200 px-8 py-2 flex items-center justify-between text-xs text-gray-500">
            <span>Operating Environment: <strong>{selectedCompany.name}</strong></span>
            <span>ID: {selectedCompany.id}</span>
        </div>
        {children}
      </main>
    </div>
  );
};
