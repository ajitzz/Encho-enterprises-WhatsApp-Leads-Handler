import React, { useState, useEffect, useRef } from 'react';
import { Node, Edge } from '@xyflow/react';
import { Send, Bot, User, RefreshCw, X } from 'lucide-react';

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
  video?: string;
  options?: string[];
}

export const TestBotChat: React.FC<TestBotChatProps> = ({ nodes, edges, onClose }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  // Start the bot
  useEffect(() => {
    if (nodes && nodes.length > 0) {
        startBot();
    } else {
        setMessages([{
            id: 'error', 
            sender: 'bot', 
            text: '⚠️ No bot flow found. Please add nodes to the canvas first.'
        }]);
    }
  }, []);

  const startBot = () => {
    setMessages([]);
    const startNode = nodes.find(n => n.data.type === 'start');
    if (startNode) {
      processNode(startNode.id, true);
    } else {
      addBotMessage("Error: No 'Start' node found. Add a Start Node to begin.");
    }
  };

  const addBotMessage = (text?: string, mediaUrl?: string, options?: string[], label?: string) => {
    setIsTyping(true);
    setTimeout(() => {
      const msg: ChatMessage = {
        id: Date.now().toString(),
        sender: 'bot',
        text,
        options
      };

      if (label === 'Video' || (mediaUrl && mediaUrl.includes('.mp4'))) {
          msg.video = mediaUrl;
      } else if (label === 'Image' || (mediaUrl && (mediaUrl.includes('.jpg') || mediaUrl.includes('.png')))) {
          msg.image = mediaUrl;
      } else if (mediaUrl) {
          msg.text = `${text || ''} \n[📎 Attachment: ${mediaUrl}]`;
      }

      setMessages(prev => [...prev, msg]);
      setIsTyping(false);
    }, 600);
  };

  const addUserMessage = (text: string) => {
    setMessages(prev => [...prev, {
      id: Date.now().toString(),
      sender: 'user',
      text
    }]);
  };

  const processNode = (nodeId: string, isInitial = false) => {
    setCurrentNodeId(nodeId);
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    // If it's a content node, show it
    if (node.data.type !== 'start') {
        const { message, mediaUrl, options, inputType, label } = node.data;
        
        // Show content
        if (message || mediaUrl || (options && options.length > 0)) {
            addBotMessage(message, mediaUrl, options, label);
        }

        // Determine if we should wait for input
        const isInput = ['text', 'number', 'email', 'date', 'time'].includes(inputType) || inputType === 'option' || (options && options.length > 0);
        
        if (!isInput) {
            // Auto-advance after delay (for Statements)
            setTimeout(() => {
                const outgoingEdge = edges.find(e => 
                    e.source === nodeId && 
                    (e.sourceHandle === 'main' || e.sourceHandle === null || e.sourceHandle === undefined)
                );
                
                if (outgoingEdge) {
                    processNode(outgoingEdge.target);
                }
            }, 1000);
            return; // Don't wait for user
        }
    } else if (isInitial) {
        // Start node, just find next
        const outgoingEdge = edges.find(e => e.source === nodeId);
        if (outgoingEdge) {
            processNode(outgoingEdge.target);
        }
    }
  };

  const handleSend = (text: string) => {
    if (!text.trim()) return;
    
    addUserMessage(text);
    setInputText('');

    if (!currentNodeId) return;

    const currentNode = nodes.find(n => n.id === currentNodeId);
    if (!currentNode) return;

    let nextEdge: Edge | undefined;

    // 1. Check for Option Match
    if (currentNode.data.options && currentNode.data.options.length > 0) {
        const index = currentNode.data.options.findIndex((opt: string) => 
            opt.toLowerCase() === text.toLowerCase()
        );
        if (index !== -1) {
            nextEdge = edges.find(e => e.source === currentNodeId && e.sourceHandle === `opt_${index}`);
        }
    }

    // 2. Fallback to default handle
    if (!nextEdge) {
        nextEdge = edges.find(e => e.source === currentNodeId && (e.sourceHandle === 'main' || !e.sourceHandle));
    }

    if (nextEdge) {
        processNode(nextEdge.target);
    } else {
        setIsTyping(true);
        setTimeout(() => {
            setMessages(prev => [...prev, {
                id: 'end', sender: 'bot', text: '✅ [End of Test Flow]'
            }]);
            setIsTyping(false);
        }, 500);
    }
  };

  return (
    <div className="fixed right-6 bottom-6 w-96 h-[600px] bg-white rounded-2xl shadow-2xl border border-gray-200 flex flex-col z-[100] animate-in slide-in-from-bottom-10">
      {/* Header */}
      <div className="bg-gray-900 text-white p-4 rounded-t-2xl flex justify-between items-center shadow-md">
        <div className="flex items-center gap-2">
            <Bot size={18} />
            <span className="font-bold">Test Bot</span>
        </div>
        <div className="flex gap-2">
            <button onClick={startBot} className="hover:bg-gray-700 p-1.5 rounded-full transition-colors" title="Restart">
                <RefreshCw size={16} />
            </button>
            <button onClick={onClose} className="hover:bg-gray-700 p-1.5 rounded-full transition-colors">
                <X size={16} />
            </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50">
        {messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] p-3 rounded-2xl text-sm ${msg.sender === 'user' ? 'bg-blue-600 text-white rounded-br-none' : 'bg-white border border-gray-200 text-gray-800 rounded-bl-none shadow-sm'}`}>
                    
                    {msg.video && (
                         <div className="mb-2 rounded-lg overflow-hidden bg-black flex items-center justify-center relative">
                            <video src={msg.video} controls className="w-full max-h-48" />
                         </div>
                    )}

                    {msg.image && (
                        <img src={msg.image} alt="Bot Media" className="w-full h-32 object-cover rounded-lg mb-2" />
                    )}

                    {msg.text && <p className="whitespace-pre-wrap">{msg.text}</p>}
                    
                    {/* Interactive Buttons */}
                    {msg.options && (
                        <div className="mt-3 flex flex-col gap-2">
                            {msg.options.map((opt) => (
                                <button 
                                    key={opt}
                                    onClick={() => handleSend(opt)}
                                    className="bg-blue-50 text-blue-700 hover:bg-blue-100 py-2 px-3 rounded-lg text-xs font-semibold transition-colors border border-blue-100 text-left"
                                >
                                    {opt}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        ))}
        {isTyping && (
             <div className="flex justify-start">
                <div className="bg-white border border-gray-200 px-4 py-3 rounded-2xl rounded-bl-none shadow-sm">
                    <div className="flex gap-1">
                        <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></span>
                        <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-75"></span>
                        <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-150"></span>
                    </div>
                </div>
             </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-3 bg-white border-t border-gray-200 rounded-b-2xl">
        <form 
            onSubmit={(e) => { e.preventDefault(); handleSend(inputText); }}
            className="flex gap-2"
        >
            <input 
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="Type a reply..."
                className="flex-1 bg-gray-100 border-none rounded-xl px-4 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
            />
            <button type="submit" className="bg-blue-600 hover:bg-blue-700 text-white p-2 rounded-xl transition-colors">
                <Send size={18} />
            </button>
        </form>
      </div>
    </div>
  );
};
