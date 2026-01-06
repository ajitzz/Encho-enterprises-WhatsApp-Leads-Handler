import React, { useState, useRef, useEffect } from 'react';
import { liveApiService } from '../services/liveApiService';
import { Send, Bot, Sparkles, X, ChevronDown, Minimize2, Loader2, Terminal } from 'lucide-react';

interface ChatMessage {
    role: 'user' | 'model';
    parts: { text: string }[];
}

export const AssistantChat = () => {
    const [isOpen, setIsOpen] = useState(false);
    const [input, setInput] = useState('');
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // Auto-scroll
    useEffect(() => {
        if (messagesEndRef.current) {
            messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages]);

    const handleSend = async () => {
        if (!input.trim()) return;
        
        const userMsg: ChatMessage = { role: 'user', parts: [{ text: input }] };
        const newHistory = [...messages, userMsg];
        
        setMessages(newHistory);
        setInput('');
        setIsLoading(true);

        try {
            const result = await liveApiService.sendAssistantMessage(input, messages);
            const botMsg: ChatMessage = { role: 'model', parts: [{ text: result.text }] };
            setMessages([...newHistory, botMsg]);
        } catch (e) {
            const errorMsg: ChatMessage = { role: 'model', parts: [{ text: "I'm having trouble connecting to the command center. If this operation took too long, it might still complete in the background." }] };
            setMessages([...newHistory, errorMsg]);
        } finally {
            setIsLoading(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    if (!isOpen) {
        return (
            <button 
                onClick={() => setIsOpen(true)}
                className="fixed bottom-6 left-6 bg-black text-white p-4 rounded-full shadow-2xl hover:bg-gray-800 transition-all z-50 group flex items-center gap-2 pr-6"
            >
                <div className="relative">
                    <Bot size={24} />
                    <span className="absolute -top-1 -right-1 flex h-3 w-3">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
                    </span>
                </div>
                <span className="font-bold tracking-tight">Fleet Commander</span>
            </button>
        );
    }

    return (
        <div className="fixed bottom-6 left-6 w-[400px] h-[600px] bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden z-50 border border-gray-200 animate-in slide-in-from-bottom-10 fade-in duration-300">
            {/* Header */}
            <div className="bg-black text-white p-4 flex justify-between items-center shrink-0">
                <div className="flex items-center gap-3">
                    <div className="bg-gradient-to-tr from-purple-500 to-blue-500 p-2 rounded-lg">
                        <Sparkles size={18} className="text-white" />
                    </div>
                    <div>
                        <h3 className="font-bold text-sm">Fleet Commander</h3>
                        <p className="text-[10px] text-gray-400">Powered by Gemini 2.0</p>
                    </div>
                </div>
                <div className="flex gap-2">
                    <button onClick={() => setIsOpen(false)} className="hover:bg-gray-800 p-1.5 rounded-lg transition-colors">
                        <Minimize2 size={16} />
                    </button>
                </div>
            </div>

            {/* Chat Area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50">
                {messages.length === 0 && (
                    <div className="h-full flex flex-col items-center justify-center text-center p-6 opacity-60">
                        <Bot size={48} className="text-gray-300 mb-4" />
                        <h4 className="font-bold text-gray-700">How can I help you?</h4>
                        <p className="text-xs text-gray-500 mt-2 max-w-[200px]">
                            I have full access to manage leads, read code, and deploy updates via GitHub.
                        </p>
                        <div className="mt-6 flex flex-col gap-2 w-full">
                            <button onClick={() => { setInput("List all files in the project"); }} className="text-xs bg-white border border-gray-200 py-2 px-3 rounded-lg hover:bg-blue-50 hover:text-blue-600 transition-colors">"List all files in the project"</button>
                            <button onClick={() => { setInput("Check the status of new leads"); }} className="text-xs bg-white border border-gray-200 py-2 px-3 rounded-lg hover:bg-blue-50 hover:text-blue-600 transition-colors">"Check status of new leads"</button>
                        </div>
                    </div>
                )}

                {messages.map((msg, idx) => (
                    <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div 
                            className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm shadow-sm leading-relaxed whitespace-pre-wrap ${
                                msg.role === 'user' 
                                    ? 'bg-black text-white rounded-tr-none' 
                                    : 'bg-white text-gray-800 border border-gray-100 rounded-tl-none'
                            }`}
                        >
                            {msg.parts[0].text}
                        </div>
                    </div>
                ))}
                
                {isLoading && (
                    <div className="flex justify-start">
                        <div className="bg-white border border-gray-100 rounded-2xl rounded-tl-none px-4 py-3 shadow-sm flex items-center gap-3">
                            <div className="relative">
                                <Terminal size={16} className="text-blue-600" />
                                <span className="absolute -top-1 -right-1 flex h-2 w-2">
                                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                                  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                                </span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-xs text-gray-700 font-bold">Processing...</span>
                                <span className="text-[10px] text-gray-400">Interacting with GitHub & Database</span>
                            </div>
                        </div>
                    </div>
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="p-4 bg-white border-t border-gray-100 shrink-0">
                <div className="relative">
                    <textarea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Type a command..."
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl pl-4 pr-12 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-black/5 focus:border-gray-300 resize-none h-12 max-h-32"
                        rows={1}
                    />
                    <button 
                        onClick={handleSend}
                        disabled={!input.trim() || isLoading}
                        className="absolute right-2 top-2 p-1.5 bg-black text-white rounded-lg hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    >
                        <Send size={16} />
                    </button>
                </div>
            </div>
        </div>
    );
};