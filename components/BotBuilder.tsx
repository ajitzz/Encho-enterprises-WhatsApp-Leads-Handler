import React, { useState, useCallback, useEffect } from 'react';
import { 
  ReactFlow, 
  MiniMap, 
  Controls, 
  Background, 
  useNodesState, 
  useEdgesState, 
  addEdge,
  Handle, 
  Position,
  Node,
  Edge,
  Connection,
  Panel,
  ReactFlowProvider,
  useReactFlow,
  MarkerType
} from '@xyflow/react';
import { BotSettings, BotStep } from '../types';
import { mockBackend } from '../services/mockBackend';
import { liveApiService } from '../services/liveApiService';
import { TestBotChat } from './TestBotChat';
import { 
  Save, MessageSquare, Image as ImageIcon, Video, FileText, MapPin, 
  List, Type, Hash, Mail, Globe, Calendar, Clock, Phone, 
  CreditCard, ShoppingBag, LayoutGrid, MoreHorizontal, X, Trash2,
  Zap, CheckCircle, Flag, Pencil, Bold, Italic, Link, Play, Music, Upload
} from 'lucide-react';

// --- STYLES & CONSTANTS ---
const HANDLE_STYLE = { width: 8, height: 8, background: '#9ca3af', border: '2px solid white' };
const ACTIVE_HANDLE_STYLE = { width: 10, height: 10, background: '#3b82f6', border: '2px solid white' };

// --- HELPER: YouTube Thumbnail ---
const getYoutubeId = (url: string) => {
  if (!url) return null;
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
};

// --- CUSTOM NODE COMPONENT ---
const CustomNode = ({ data, id, selected }: any) => {
  const [options, setOptions] = useState<string[]>(data.options || []);
  const [variableName, setVariableName] = useState(data.saveToField || '');
  
  // Sync internal state with data prop when it changes externally
  useEffect(() => {
    setOptions(data.options || []);
    setVariableName(data.saveToField || '');
  }, [data.options, data.saveToField]);

  const handleChange = (field: string, value: any) => {
    data.onChange?.(id, { ...data, [field]: value });
  };

  const handleOptionChange = (idx: number, val: string) => {
    const newOpts = [...options];
    newOpts[idx] = val;
    setOptions(newOpts);
    handleChange('options', newOpts);
  };

  const addOption = () => {
    const newOpts = [...options, `Option ${options.length + 1}`];
    setOptions(newOpts);
    handleChange('options', newOpts);
  };

  const removeOption = (idx: number) => {
    const newOpts = options.filter((_, i) => i !== idx);
    setOptions(newOpts);
    handleChange('options', newOpts);
  };

  // --- 1. START NODE (Special Case) ---
  if (data.type === 'start') {
    return (
      <div className={`p-4 bg-white rounded-2xl shadow-sm border-2 min-w-[240px] ${selected ? 'border-blue-500' : 'border-gray-100 hover:border-gray-200'} transition-colors`}>
        <div className="mb-2">
           <span className="text-xs font-bold text-gray-900">Start</span>
        </div>
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 flex items-center gap-3 text-gray-700">
           <Flag size={16} className="text-gray-500" />
           <span className="text-sm font-medium">Start</span>
        </div>
        <Handle type="source" position={Position.Right} style={ACTIVE_HANDLE_STYLE} className="-right-3" />
      </div>
    );
  }

  const isInputType = ['Text', 'Number', 'Email', 'Website', 'Date', 'Time'].includes(data.label);
  const isMediaType = ['Image', 'Video', 'File', 'Audio'].includes(data.label);
  const isOptionType = ['Quick Reply', 'List'].includes(data.label);

  // --- 2. EDIT MODE (Selected) ---
  if (selected) {
    return (
        <div className="w-[400px] bg-white rounded-xl shadow-2xl border-2 border-blue-500 ring-4 ring-blue-50 transition-all duration-200 z-50 relative animate-in zoom-in-95 duration-200">
             <Handle type="target" position={Position.Left} style={HANDLE_STYLE} className="-left-2.5" />
             
             <div className="p-4">
                {/* --- MEDIA TYPES (Image, Video, File) --- */}
                {isMediaType && (
                    <>
                        {/* Tabs */}
                        <div className="flex items-center gap-4 mb-4">
                            <span className="text-sm font-medium text-gray-400 cursor-pointer hover:text-gray-600">Upload</span>
                            <span className="text-sm font-bold text-gray-800 bg-gray-100 px-3 py-1.5 rounded-md flex items-center gap-1">
                                Embed link <span className="text-red-500">*</span>
                            </span>
                        </div>

                        {/* URL Input */}
                        <label className="block text-sm font-medium text-gray-900 mb-2">{data.label} URL <span className="text-red-500">*</span></label>
                        <div className="relative mb-4 group/input">
                            <input 
                                type="text" 
                                className="w-full border border-gray-200 rounded-lg py-2.5 pl-3 pr-9 text-sm text-gray-700 placeholder-gray-400 outline-none focus:border-green-500 transition-colors"
                                placeholder={`Paste ${data.label.toLowerCase()} link...`}
                                value={data.mediaUrl || ''}
                                onChange={(e) => handleChange('mediaUrl', e.target.value)}
                            />
                            <div className="absolute right-3 top-3 text-gray-400 group-focus-within/input:text-green-500 pointer-events-none">
                                <Pencil size={14} />
                            </div>
                        </div>

                        {/* Caption (Image/Video only) */}
                        {(data.label === 'Image' || data.label === 'Video') && (
                            <div className="relative group/caption">
                                <label className="block text-sm font-medium text-gray-900 mb-2">Caption:</label>
                                <textarea 
                                    className="w-full border border-gray-200 rounded-lg py-2.5 pl-3 pr-9 text-sm text-gray-700 outline-none focus:border-green-500 transition-colors resize-none bg-white"
                                    rows={2}
                                    value={data.message || ''}
                                    onChange={(e) => handleChange('message', e.target.value)}
                                />
                                <div className="absolute right-3 bottom-2 text-[10px] text-gray-400 font-medium bg-white px-1">
                                    {data.message?.length || 0}/1024
                                </div>
                            </div>
                        )}
                    </>
                )}

                {/* --- TEXT TYPE --- */}
                {(data.label === 'Text') && (
                    <div className="rounded-xl border border-green-500 ring-1 ring-green-100 transition-all duration-200">
                        <div className="flex items-center gap-4 px-4 py-3 border-b border-gray-100/50">
                            <button className="text-gray-400 hover:text-gray-600 transition-colors"><Pencil size={14} /></button>
                            <button className="text-gray-400 hover:text-gray-600 transition-colors"><Bold size={14} /></button>
                            <button className="text-gray-400 hover:text-gray-600 transition-colors"><Italic size={14} /></button>
                        </div>
                        <div className="p-4 relative">
                            <textarea 
                                className="w-full bg-transparent border-none p-0 text-sm text-gray-800 placeholder-gray-300 focus:ring-0 resize-none leading-relaxed font-medium"
                                rows={4}
                                placeholder="Enter your message..."
                                value={data.message}
                                onChange={(e) => handleChange('message', e.target.value)}
                            />
                            <div className="text-[10px] text-gray-400 text-right mt-2 font-medium">
                                {data.message?.length || 0}/1024
                            </div>
                        </div>
                    </div>
                )}

                {/* --- CHOICE TYPES --- */}
                {isOptionType && (
                    <div className="space-y-3">
                         <div className="bg-gray-50 p-3 rounded-lg border border-gray-200 mb-3">
                            <textarea 
                                className="w-full bg-transparent border-none p-0 text-sm text-gray-800 placeholder-gray-400 focus:ring-0 resize-none leading-relaxed"
                                rows={2}
                                placeholder="Ask a question..."
                                value={data.message}
                                onChange={(e) => handleChange('message', e.target.value)}
                            />
                         </div>
                         <label className="block text-xs font-bold text-gray-500 uppercase">Options</label>
                         <div className="space-y-2 max-h-[200px] overflow-y-auto pr-1">
                            {options.map((opt, idx) => (
                                <div key={idx} className="flex items-center gap-2">
                                    <div className="flex-1 flex items-center bg-white border border-gray-200 rounded-lg pl-3 pr-1 py-2 shadow-sm focus-within:ring-2 focus-within:ring-blue-500">
                                        <span className="text-[10px] text-gray-400 mr-2 font-mono">{idx + 1}</span>
                                        <input 
                                            value={opt}
                                            onChange={(e) => handleOptionChange(idx, e.target.value)}
                                            className="flex-1 bg-transparent border-none p-0 text-sm text-gray-700 outline-none"
                                            placeholder="Option label"
                                        />
                                        <button onClick={() => removeOption(idx)} className="p-1 text-gray-300 hover:text-red-400">
                                            <X size={12} />
                                        </button>
                                    </div>
                                    <Handle type="source" position={Position.Right} id={`opt_${idx}`} style={{...ACTIVE_HANDLE_STYLE, position: 'relative', transform: 'none', right: 0}} />
                                </div>
                            ))}
                         </div>
                         <button 
                            onClick={addOption}
                            className="w-full py-2 border border-dashed border-gray-300 rounded-lg text-xs font-medium text-gray-500 hover:text-blue-600 hover:border-blue-400 hover:bg-blue-50 transition-all flex items-center justify-center gap-1"
                         >
                            <List size={12} /> Add Choice
                         </button>
                    </div>
                )}

                {/* --- INPUT TYPES --- */}
                {isInputType && (
                    <div className="space-y-4">
                        <div className="bg-gray-50 p-3 rounded-lg border border-gray-200">
                             <label className="block text-xs font-bold text-gray-500 mb-1">Question</label>
                            <textarea 
                                className="w-full bg-transparent border-none p-0 text-sm text-gray-800 placeholder-gray-400 focus:ring-0 resize-none leading-relaxed"
                                rows={2}
                                placeholder={`Ask for ${data.label.toLowerCase()}...`}
                                value={data.message}
                                onChange={(e) => handleChange('message', e.target.value)}
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-gray-500 mb-1">Save Response To</label>
                            <div className="relative">
                                <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
                                    <Hash size={12} className="text-purple-500" />
                                </div>
                                <select 
                                    value={variableName}
                                    onChange={(e) => {
                                        setVariableName(e.target.value);
                                        handleChange('saveToField', e.target.value);
                                    }}
                                    className="w-full pl-8 pr-3 py-2.5 bg-purple-50 border border-purple-100 text-purple-900 text-xs font-bold rounded-lg focus:ring-2 focus:ring-purple-500 outline-none appearance-none cursor-pointer"
                                >
                                    <option value="">Select variable...</option>
                                    <option value="name">user_name</option>
                                    <option value="vehicleRegistration">vehicle_number</option>
                                    <option value="availability">availability_status</option>
                                    <option value="document">uploaded_document_url</option>
                                    <option value="email">email_address</option>
                                    <option value="phone">phone_number</option>
                                </select>
                            </div>
                        </div>
                    </div>
                )}
             </div>

             {/* Single Main Output Handle for non-option types */}
             {!isOptionType && (
                 <Handle type="source" position={Position.Right} id="main" style={{...ACTIVE_HANDLE_STYLE, right: -12, top: '50%'}} />
             )}
        </div>
    );
  }

  // --- 3. PREVIEW MODE (Unselected) ---
  return (
    <div className="w-[280px] bg-white rounded-2xl shadow-md border border-gray-200 transition-all hover:border-gray-300 hover:shadow-lg group relative cursor-pointer">
        <Handle type="target" position={Position.Left} style={HANDLE_STYLE} className="-left-2.5" />
        
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
                <span className="text-gray-500">
                    {data.icon || (data.label === 'Video' ? <Video size={14} /> : <MessageSquare size={14} />)}
                </span>
                <span className="text-xs font-bold text-gray-900">Group #{id.split('_')[1] || id.slice(-4)}</span>
            </div>
            <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                <button onClick={(e) => { e.stopPropagation(); data.onDelete?.(id); }} className="text-gray-400 hover:text-red-500 p-1">
                    <Trash2 size={12} />
                </button>
            </div>
        </div>

        {/* Preview Content */}
        <div className="p-4">
            
            {/* Text Preview */}
            {(data.label === 'Text') && (
                <p className="text-sm text-gray-600 line-clamp-3 font-medium">
                    {data.message || <span className="text-gray-300 italic">Empty text message...</span>}
                </p>
            )}

            {/* Image Preview */}
            {data.label === 'Image' && (
                <div className="space-y-2">
                     <div className="relative aspect-video bg-gray-100 rounded-lg overflow-hidden border border-gray-100">
                        {data.mediaUrl ? (
                            <img src={data.mediaUrl} alt="Preview" className="w-full h-full object-cover" />
                        ) : (
                            <div className="flex items-center justify-center h-full text-gray-300">
                                <ImageIcon size={24} />
                            </div>
                        )}
                     </div>
                     {data.message && <p className="text-xs text-gray-500 truncate">{data.message}</p>}
                </div>
            )}

            {/* Video Preview */}
            {data.label === 'Video' && (
                <div className="relative w-full aspect-video bg-gray-100 rounded-lg overflow-hidden group/video">
                    {getYoutubeId(data.mediaUrl) ? (
                        <img src={`https://img.youtube.com/vi/${getYoutubeId(data.mediaUrl)}/mqdefault.jpg`} alt="Video" className="w-full h-full object-cover" />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center bg-gray-100">
                             <Video size={32} className="text-gray-300" />
                        </div>
                    )}
                    <div className="absolute inset-0 flex items-center justify-center bg-black/10">
                        <div className="w-8 h-8 bg-red-600 rounded-full flex items-center justify-center shadow-md">
                             <Play size={12} fill="white" className="text-white ml-0.5" />
                        </div>
                    </div>
                </div>
            )}

            {/* File Preview */}
            {data.label === 'File' && (
                <div className="flex items-center gap-3 p-3 bg-blue-50 rounded-lg border border-blue-100">
                    <div className="bg-white p-2 rounded-md shadow-sm text-blue-600">
                        <FileText size={16} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold text-gray-700 truncate">Document</p>
                        <p className="text-[10px] text-gray-500 truncate">{data.mediaUrl || 'No file selected'}</p>
                    </div>
                </div>
            )}

             {/* Choices Preview */}
             {isOptionType && (
                <div className="space-y-2">
                    <p className="text-xs text-gray-600 mb-2">{data.message || 'Select an option:'}</p>
                    <div className="flex flex-col gap-1.5">
                        {options.map((opt, i) => (
                            <div key={i} className="w-full bg-gray-50 border border-gray-200 text-gray-600 py-1.5 px-3 rounded text-xs font-medium text-center relative">
                                {opt}
                                <Handle type="source" position={Position.Right} id={`opt_${i}`} style={{...HANDLE_STYLE, right: -21}} />
                            </div>
                        ))}
                        {options.length === 0 && <span className="text-xs text-gray-400 italic">No options added</span>}
                    </div>
                </div>
             )}

             {/* Input Preview */}
             {isInputType && (
                <div className="space-y-2">
                    <p className="text-xs text-gray-600 mb-2">{data.message || `Please enter ${data.label.toLowerCase()}...`}</p>
                    <div className="bg-gray-50 border border-gray-200 rounded px-3 py-2 text-xs text-gray-400 flex items-center justify-between">
                        <span>User types {data.label}...</span>
                        {data.saveToField && <span className="text-[9px] bg-purple-100 text-purple-600 px-1 rounded">{data.saveToField}</span>}
                    </div>
                </div>
             )}

        </div>

        {/* Main Source Handle (if not option type) */}
        {!isOptionType && (
            <Handle type="source" position={Position.Right} id="main" style={{...HANDLE_STYLE, right: -12, top: '50%'}} />
        )}
    </div>
  );
};

const nodeTypes = {
  custom: CustomNode,
};

// --- SIDEBAR CONFIGURATION ---
const SIDEBAR_CATEGORIES = [
    {
        title: 'Messages',
        items: [
            { type: 'text', label: 'Text', icon: <MessageSquare size={16} /> },
            { type: 'image', label: 'Image', icon: <ImageIcon size={16} />, hasMedia: true },
            { type: 'video', label: 'Video', icon: <Video size={16} />, hasMedia: true },
            { type: 'file', label: 'File', icon: <FileText size={16} /> },
            { type: 'location', label: 'Location', icon: <MapPin size={16} /> },
            { type: 'link', label: 'Link', icon: <Link size={16} /> },
        ]
    },
    {
        title: 'Choices',
        items: [
            { type: 'option', inputType: 'option', label: 'Quick Reply', icon: <LayoutGrid size={16} /> },
            { type: 'option', inputType: 'option', label: 'List', icon: <List size={16} /> },
        ]
    },
    {
        title: 'Inputs',
        items: [
            { type: 'input', inputType: 'text', label: 'Text', icon: <Type size={16} /> },
            { type: 'input', inputType: 'text', label: 'Number', icon: <Hash size={16} /> },
            { type: 'input', inputType: 'text', label: 'Email', icon: <Mail size={16} /> },
            { type: 'input', inputType: 'text', label: 'Website', icon: <Globe size={16} /> },
            { type: 'input', inputType: 'text', label: 'Date', icon: <Calendar size={16} /> },
            { type: 'input', inputType: 'text', label: 'Time', icon: <Clock size={16} /> },
        ]
    }
];

// --- MAIN BUILDER ---

interface BotBuilderProps {
    isLiveMode?: boolean; 
}

const initialNodes: Node[] = [
    { 
        id: 'start', 
        type: 'custom', 
        position: { x: 50, y: 300 }, 
        data: { type: 'start' } 
    }
];

export const BotBuilder: React.FC<BotBuilderProps> = ({ isLiveMode = false }) => {
  return (
    <ReactFlowProvider>
        <FlowEditor isLiveMode={isLiveMode} />
    </ReactFlowProvider>
  );
};

const FlowEditor = ({ isLiveMode }: { isLiveMode: boolean }) => {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isTestChatOpen, setIsTestChatOpen] = useState(false);
  const reactFlowInstance = useReactFlow();

  // Load Data
  useEffect(() => {
    const load = async () => {
        let settings: BotSettings;
        if (isLiveMode) {
             try {
                settings = await liveApiService.getBotSettings();
             } catch(e) { console.error("Could not fetch settings:", e); return; }
        } else {
             settings = mockBackend.getBotSettings();
        }

        if (settings && settings.flowData && settings.flowData.nodes.length > 0) {
            // Restore visual state
            const restoredNodes = settings.flowData.nodes.map((n: any) => ({
                ...n,
                data: {
                    ...n.data,
                    onChange: updateNodeData,
                    onDelete: deleteNode
                }
            }));
            setNodes(restoredNodes);
            setEdges(settings.flowData.edges);
        }
    };
    load();
  }, [isLiveMode]);

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge({ 
        ...params, 
        type: 'smoothstep',
        animated: true, 
        style: { stroke: '#9ca3af', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#9ca3af' } 
    }, eds)),
    [setEdges],
  );

  const updateNodeData = (id: string, newData: any) => {
    setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: newData } : n)));
  };

  const deleteNode = (id: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
  };

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const type = event.dataTransfer.getData('application/reactflow/type');
      const inputType = event.dataTransfer.getData('application/reactflow/inputType');
      const label = event.dataTransfer.getData('application/reactflow/label');

      if (typeof type === 'undefined' || !type) return;

      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      // Icon Reconstruction
      let icon = <MessageSquare size={16} className="text-gray-600" />;
      if(label === 'Image') icon = <ImageIcon size={16} className="text-gray-600" />;
      if(inputType === 'option') icon = <List size={16} className="text-gray-600" />;
      if(label === 'Video') icon = <Video size={16} className="text-gray-600" />;
      if(label === 'File') icon = <FileText size={16} className="text-gray-600" />;

      const newNode: Node = {
        id: `node_${Date.now()}`,
        type: 'custom',
        position,
        data: { 
            label: label,
            icon: icon,
            message: '', 
            inputType: inputType || 'text', 
            hasMedia: type === 'image' || type === 'video' || type === 'file',
            onChange: updateNodeData, 
            onDelete: deleteNode,
            options: inputType === 'option' ? ['Yes', 'No'] : undefined
        },
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [reactFlowInstance],
  );

  // --- SAVE & COMPILE ---
  const handleSave = async () => {
      setIsSaving(true);
      
      const compiledSteps: BotStep[] = [];
      
      nodes.forEach(node => {
          if (node.data.type === 'start') return;

          const outgoingEdges = edges.filter(e => e.source === node.id);
          
          let nextStepId = 'END';
          // Find logic for next step based on connection
          // Simple logic: Take the first connection from 'main' handle or default handle
          const mainEdge = outgoingEdges.find(e => e.sourceHandle === 'main' || !e.sourceHandle);
          if (mainEdge) nextStepId = mainEdge.target;
          else if (outgoingEdges.length > 0 && node.data.inputType !== 'option') nextStepId = outgoingEdges[0].target; 
          
          // For options, nextStepId is complex (one per option), simplified here for demo backend which expects linear or single branch
          // In a real sophisticated bot, 'nextStepId' might be a map. For now, we save the default flow.

          compiledSteps.push({
            id: node.id,
            title: node.data.label,
            message: node.data.message,
            inputType: node.data.inputType,
            options: node.data.options,
            saveToField: node.data.saveToField,
            nextStepId: nextStepId
          });
      });

      const newSettings: BotSettings = {
          ...mockBackend.getBotSettings(),
          steps: compiledSteps,
          flowData: { nodes, edges } 
      };

      if (isLiveMode) {
          try {
             await liveApiService.saveBotSettings(newSettings);
          } catch(e) { console.error(e); }
      } else {
          mockBackend.updateBotSettings(newSettings);
      }
      
      setTimeout(() => setIsSaving(false), 800);
  };

  return (
    <div className="flex flex-col h-full bg-gray-50 font-sans">
        
        {/* TOP BAR */}
        <div className="bg-white border-b border-gray-200 px-6 h-16 flex items-center justify-between shrink-0 z-20">
            <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                    <div className="w-8 h-8 bg-gray-900 rounded-full flex items-center justify-center text-white">
                        <Zap size={16} fill="currentColor" />
                    </div>
                    <span className="font-bold text-gray-900">My Chatbot</span>
                </div>
                
                {/* Toggles */}
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-600">Static Variables</span>
                        <div className="w-9 h-5 bg-gray-200 rounded-full relative cursor-pointer">
                            <div className="absolute left-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="flex items-center gap-4">
                 <button 
                    onClick={() => setIsTestChatOpen(!isTestChatOpen)}
                    className={`flex items-center gap-2 px-4 py-1.5 border rounded-full text-sm font-medium transition-colors ${isTestChatOpen ? 'bg-green-50 border-green-500 text-green-700' : 'border-green-500 text-green-600 hover:bg-green-50'}`}
                 >
                    <Play size={14} fill="currentColor" /> Test Bot
                 </button>
                 <div className="h-6 w-px bg-gray-200"></div>
                 <button 
                    onClick={handleSave}
                    disabled={isSaving}
                    className="bg-green-500 hover:bg-green-600 text-white px-6 py-2 rounded-full text-sm font-bold shadow-md hover:shadow-lg transition-all flex items-center gap-2"
                 >
                    {isSaving ? <span className="animate-pulse">Saving...</span> : <><CheckCircle size={16} /> Save</>}
                 </button>
            </div>
        </div>

        {/* WORKSPACE */}
        <div className="flex-1 flex overflow-hidden relative">
            
            {/* CANVAS */}
            <div className="flex-1 h-full bg-[#f8f9fa] relative" onDragOver={onDragOver} onDrop={onDrop}>
                 <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    nodeTypes={nodeTypes}
                    defaultViewport={{ x: 0, y: 0, zoom: 0.8 }}
                    minZoom={0.2}
                    maxZoom={2}
                    attributionPosition="bottom-left"
                 >
                    <Background color="#e2e8f0" gap={24} size={2} />
                    <Controls className="bg-white border border-gray-200 shadow-sm rounded-lg p-1 m-4" />
                    <MiniMap className="border border-gray-200 rounded-lg shadow-sm m-4" zoomable pannable />
                 </ReactFlow>
            </div>

            {/* TEST CHAT OVERLAY */}
            {isTestChatOpen && (
                <TestBotChat 
                    nodes={nodes} 
                    edges={edges} 
                    onClose={() => setIsTestChatOpen(false)} 
                />
            )}

            {/* RIGHT SIDEBAR */}
            <div className="w-[280px] bg-white border-l border-gray-200 flex flex-col shadow-xl z-10 overflow-hidden">
                <div className="flex-1 overflow-y-auto custom-scrollbar">
                    <div className="p-5 space-y-8">
                        {SIDEBAR_CATEGORIES.map((cat, idx) => (
                            <div key={idx}>
                                <h4 className="text-sm font-bold text-gray-700 mb-4">{cat.title}</h4>
                                <div className="grid grid-cols-2 gap-3">
                                    {cat.items.map((item, i) => (
                                        <DraggableSidebarItem key={i} {...item} />
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

        </div>
    </div>
  );
};

// --- DRAGGABLE ITEM ---
const DraggableSidebarItem = ({ type, inputType, label, icon }: any) => {
    const onDragStart = (event: React.DragEvent) => {
      event.dataTransfer.setData('application/reactflow/type', type);
      event.dataTransfer.setData('application/reactflow/inputType', inputType);
      event.dataTransfer.setData('application/reactflow/label', label);
      event.dataTransfer.effectAllowed = 'move';
    };
  
    return (
      <div 
        className="flex flex-col gap-2 cursor-grab group"
        onDragStart={onDragStart} 
        draggable
      >
        <div className="bg-white border border-dashed border-gray-200 rounded-xl px-3 py-3 flex items-center gap-3 transition-all hover:border-green-400 hover:bg-green-50/30 hover:shadow-sm">
            <div className="text-green-600">
                {icon}
            </div>
            <span className="text-sm font-medium text-gray-700">{label}</span>
        </div>
      </div>
    );
};