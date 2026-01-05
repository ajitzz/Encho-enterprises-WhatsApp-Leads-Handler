import React, { useState, useEffect, useRef } from 'react';
import { Node, Edge } from '@xyflow/react';
import { X, Send, RefreshCcw, User, Bot, Image as ImageIcon, Video, FileText } from 'lucide-react';

interface TestBotChatProps {
  nodes: Node[];
  edges: Edge[];
  onClose: () => void;
}

interface ChatMessage {
  id: string;
  sender: 'bot' | 'user';
  text?: string;
  image?: string;
  options?: string[];
  type: 'text' | 'image' | 'video' | 'file' | 'options';
}

export const TestBotChat: React.FC<TestBotChatProps> = ({ nodes, edges, onClose }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  // Start Flow on Mount
  useEffect(() => {
    startFlow();
  }, []);

  const startFlow = () => {
    setMessages([]);
    setVariables({});
    const startNode = nodes.find(n => n.data.type === 'start');
    if (startNode) {
      // Find the node connected to Start
      const firstEdge = edges.find(e => e.source === startNode.id);
      if (firstEdge) {
        processNode(firstEdge.target);
      }
    }
  };

  const processNode = async (nodeId: string) => {
    setCurrentNodeId(nodeId);
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    setIsTyping(true);

    // Simulate network delay
    setTimeout(() => {
      setIsTyping(false);
      
      const label = node.data.label;
      const rawMessage = node.data.message as string;
      const mediaUrl = node.data.mediaUrl as string;
      const options = node.data.options as string[];

      // Replace variables
      const text = rawMessage.replace(/{{\s*(\w+)\s*}}/g, (_, key) => variables[key] || '');

      const newMessage: ChatMessage = {
        id: Date.now().toString(),
        sender: 'bot',
        text: text,
        image: (label === 'Image' || label === 'Video') ? mediaUrl : undefined,
        options: (label === 'Quick Reply' || label === 'List' || node.data.inputType === 'option') ? options : undefined,
        type: label === 'Image' ? 'image' : label === 'Video' ? 'video' : label === 'File' ? 'file' : 'text'
      };

      setMessages(prev => [...prev, newMessage]);

      // If it's a display-only node (no input required), move to next automatically
      // Logic: If inputType is NOT 'option' AND label is NOT 'Text'/'Input' related
      // Simplified: If it's just an Image/Video without a question, usually we wait, 
      // BUT in this builder logic, 'Image' nodes might just be display. 
      // However, usually every node waits for a step. 
      // EXCEPTION: If the node has NO options and NO saveToField and is NOT text input, maybe auto-skip?
      // For now, let's assume all nodes wait for user ack unless specifically designed otherwise.
      // Actually, looking at the previous logic, only 'Start' is skipped.
      
    }, 800);
  };

  const handleSendMessage = (text: string) => {
    if (!text.trim()) return;

    // 1. Add User Message
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      sender: 'user',
      text: text,
      type: 'text'
    };
    setMessages(prev => [...prev, userMsg]);
    setInputText('');

    // 2. Logic to find next node
    if (!currentNodeId) return;

    const currentNode = nodes.find(n => n.id === currentNodeId);
    if (!currentNode) return;

    // Save Variable
    if (currentNode.data.saveToField) {
      setVariables(prev => ({ ...prev, [currentNode.data.saveToField]: text }));
    }

    // Find Edge
    let nextEdge: Edge | undefined;

    // If options, try to match specific handle
    if (currentNode.data.inputType === 'option' || currentNode.data.options) {
      const optionIndex = (currentNode.data.options as string[])?.indexOf(text);
      if (optionIndex !== -1) {
        nextEdge = edges.find(e => e.source === currentNodeId && e.sourceHandle === `opt_${optionIndex}`);
      }
    }

    // Fallback to main edge
    if (!nextEdge) {
      nextEdge = edges.find(e => e.source === currentNodeId && (e.sourceHandle === 'main' || !e.sourceHandle));
    }

    if (nextEdge) {
      processNode(nextEdge.target);
    } else {
      setIsTyping(true);
      setTimeout(() => {
        setIsTyping(false);
        setMessages(prev => [...prev, {
          id: 'end',
          sender: 'bot',
          text: 'End of Flow.',
          type: 'text'
        }]);
      }, 500);
    }
  };

  return (
    <div className="fixed inset-y-0 right-0 w-[400px] bg-white shadow-2xl z-[60] flex flex-col border-l border-gray-200 animate-in slide-in-from-right duration-300">
      {/* Header */}
      <div className="bg-gray-900 text-white p-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Bot size={20} className="text-green-400" />
          <div>
            <h3 className="font-bold text-sm">Test Bot</h3>
            <p className="text-[10px] text-gray-400 flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></span>
              Live Preview
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
           <button onClick={startFlow} className="p-2 hover:bg-gray-800 rounded-full transition-colors text-gray-300 hover:text-white" title="Restart Flow">
             <RefreshCcw size={16} />
           </button>
           <button onClick={onClose} className="p-2 hover:bg-gray-800 rounded-full transition-colors text-gray-300 hover:text-white">
             <X size={20} />
           </button>
        </div>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-4 bg-[#e5ded8] space-y-4 relative">
        {/* Background Pattern */}
        <div className="absolute inset-0 opacity-10 pointer-events-none" style={{ backgroundImage: 'url("https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png")' }}></div>

        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'} relative z-10`}>
            <div className={`max-w-[85%] rounded-lg p-3 shadow-sm text-sm ${
              msg.sender === 'user' 
                ? 'bg-[#d9fdd3] text-gray-800 rounded-tr-none' 
                : 'bg-white text-gray-800 rounded-tl-none'
            }`}>
              
              {/* Media Rendering */}
              {msg.type === 'image' && msg.image && (
                 <img src={msg.image} alt="content" className="w-full h-auto rounded-lg mb-2 border border-gray-100" />
              )}
              {msg.type === 'video' && msg.image && (
                 <div className="relative w-full aspect-video bg-black rounded-lg mb-2 overflow-hidden flex items-center justify-center">
                    <img src={`https://img.youtube.com/vi/${msg.image.split('v=')[1]}/mqdefault.jpg`} className="w-full h-full object-cover opacity-60" />
                    <div className="absolute w-10 h-10 bg-red-600 rounded-full flex items-center justify-center text-white">▶</div>
                 </div>
              )}

              {/* Text Rendering */}
              <p className="whitespace-pre-wrap leading-relaxed">{msg.text}</p>
              
              {/* Timestamp */}
              <div className={`text-[9px] mt-1 text-right ${msg.sender === 'user' ? 'text-green-800/60' : 'text-gray-400'}`}>
                {new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
              </div>
            </div>
          </div>
        ))}

        {isTyping && (
          <div className="flex justify-start relative z-10">
             <div className="bg-white rounded-lg p-3 rounded-tl-none shadow-sm flex gap-1 items-center">
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"></span>
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce delay-100"></span>
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce delay-200"></span>
             </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Options / Input Area */}
      <div className="bg-[#f0f2f5] p-3 border-t border-gray-200 shrink-0 z-20">
        
        {/* Render Options if available */}
        {messages.length > 0 && messages[messages.length - 1].sender === 'bot' && messages[messages.length - 1].options && (
            <div className="flex flex-wrap gap-2 mb-3 justify-center">
                {messages[messages.length - 1].options?.map((opt, idx) => (
                    <button
                        key={idx}
                        onClick={() => handleSendMessage(opt)}
                        className="bg-white text-blue-600 font-semibold px-4 py-2 rounded-full shadow-sm text-sm hover:bg-gray-50 border border-gray-200 transition-all transform active:scale-95"
                    >
                        {opt}
                    </button>
                ))}
            </div>
        )}

        <div className="flex items-center gap-2">
           <input 
             type="text" 
             value={inputText}
             onChange={(e) => setInputText(e.target.value)}
             onKeyDown={(e) => e.key === 'Enter' && handleSendMessage(inputText)}
             placeholder="Type a message..."
             className="flex-1 bg-white border border-gray-300 text-gray-900 text-sm rounded-full focus:ring-2 focus:ring-green-500 focus:border-green-500 block w-full px-4 py-2.5 outline-none shadow-sm"
           />
           <button 
             onClick={() => handleSendMessage(inputText)}
             disabled={!inputText.trim()}
             className="p-2.5 bg-green-600 text-white rounded-full hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
           >
             <Send size={18} />
           </button>
        </div>
      </div>
    </div>
  );
};
