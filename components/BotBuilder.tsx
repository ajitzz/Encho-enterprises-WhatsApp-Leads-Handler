import React, { useState, useCallback, useEffect } from 'react';
import { 
  ReactFlow, 
  MiniMap, 
  Controls, 
  Background, 
  Handle, 
  Position,
  Node,
  ReactFlowProvider,
  useReactFlow,
  Panel
} from '@xyflow/react';
import { BotSettings, BotStep } from '../types';
import { mockBackend } from '../services/mockBackend';
import { liveApiService } from '../services/liveApiService';
import { useFlowStore } from '../services/flowStore'; 
import { 
  MessageSquare, Image as ImageIcon, Video, FileText, MapPin, 
  List, Type, Hash, Mail, Globe, Calendar, Clock, 
  LayoutGrid, X, Trash2, Zap, CheckCircle, Flag, Play, AlertTriangle, ShieldAlert, GripVertical, Settings
} from 'lucide-react';

// --- STYLES & CONSTANTS ---
const HANDLE_STYLE = { width: 10, height: 10, background: '#64748b', border: '2px solid white' };
const ACTIVE_HANDLE_STYLE = { width: 12, height: 12, background: '#3b82f6', border: '2px solid white' };
const PLACEHOLDER_TEXTS = ['replace this sample message', 'enter your message', 'type your message here'];

// --- CUSTOM NODE COMPONENT (WATI/AiSensy Style) ---
const CustomNode = ({ data, id, selected }: any) => {
  const updateNodeData = useFlowStore((state) => state.updateNodeData);
  const deleteNode = useFlowStore((state) => state.deleteNode);

  const [options, setOptions] = useState<string[]>(data.options || []);
  const [variableName, setVariableName] = useState(data.saveToField || '');
  
  // Local sync
  useEffect(() => {
    setOptions(data.options || []);
    setVariableName(data.saveToField || '');
  }, [data.options, data.saveToField]);

  const handleChange = (field: string, value: any) => {
    updateNodeData(id, { [field]: value });
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

  // --- START NODE ---
  if (data.type === 'start') {
    return (
      <div className={`group relative shadow-lg rounded-xl bg-white border-2 transition-all ${selected ? 'border-green-500 ring-2 ring-green-100' : 'border-gray-100'}`}>
        <div className="bg-green-50 px-4 py-2 rounded-t-xl border-b border-green-100 flex items-center gap-2">
           <Flag size={14} className="text-green-600" />
           <span className="text-xs font-bold text-green-800 uppercase tracking-wide">Starting Step</span>
        </div>
        <div className="p-4 flex items-center justify-center">
            <p className="text-sm font-medium text-gray-600">Conversation Begins Here</p>
        </div>
        <Handle type="source" position={Position.Right} style={ACTIVE_HANDLE_STYLE} className="-right-3" />
      </div>
    );
  }

  const isInputType = ['Text', 'Number', 'Email', 'Website', 'Date', 'Time'].includes(data.label);
  const isMediaType = ['Image', 'Video', 'File', 'Audio'].includes(data.label);
  const isOptionType = ['Quick Reply', 'List'].includes(data.label);
  const hasError = data.hasError;

  // --- STANDARD NODE ---
  return (
    <div className={`w-[320px] bg-white rounded-xl shadow-xl transition-all duration-200 group animate-in fade-in zoom-in-95
        ${selected ? 'ring-2 ring-blue-500 border-transparent' : 'border border-gray-200'}
        ${hasError ? 'ring-2 ring-red-500 border-red-500' : ''}
    `}>
        <Handle type="target" position={Position.Left} style={HANDLE_STYLE} className="-left-2.5" />
        
        {/* Error Flag */}
        {hasError && (
             <div className="absolute -top-3 right-4 bg-red-600 text-white px-2 py-0.5 rounded-full shadow-sm z-20 flex items-center gap-1">
                <ShieldAlert size={10} />
                <span className="text-[10px] font-bold uppercase tracking-wider">{data.errorMessage || "Invalid"}</span>
             </div>
        )}

        {/* Header */}
        <div className={`px-4 py-3 rounded-t-xl border-b flex items-center justify-between cursor-grab active:cursor-grabbing
            ${isInputType ? 'bg-purple-50 border-purple-100' : ''}
            ${isMediaType ? 'bg-amber-50 border-amber-100' : ''}
            ${!isInputType && !isMediaType ? 'bg-blue-50 border-blue-100' : ''}
        `}>
            <div className="flex items-center gap-2">
                <span className={`
                    ${isInputType ? 'text-purple-600' : ''}
                    ${isMediaType ? 'text-amber-600' : ''}
                    ${!isInputType && !isMediaType ? 'text-blue-600' : ''}
                `}>
                    {data.icon || <MessageSquare size={16} />}
                </span>
                <span className="text-xs font-bold text-gray-700 uppercase">{data.label}</span>
            </div>
            <div className="flex items-center gap-1">
                <button onClick={() => deleteNode(id)} className="text-gray-400 hover:text-red-500 p-1 rounded hover:bg-white/50 transition-colors">
                    <Trash2 size={14} />
                </button>
            </div>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
            
            {/* Media Input */}
            {isMediaType && (
                <div>
                     <label className="text-[10px] font-bold text-gray-500 uppercase mb-1 block">Media URL <span className="text-red-500">*</span></label>
                     <input 
                        type="text" 
                        className={`w-full bg-gray-50 border rounded-lg px-3 py-2 text-xs text-gray-700 outline-none transition-all ${hasError && !data.mediaUrl ? 'border-red-300 bg-red-50' : 'border-gray-200 focus:border-blue-500'}`}
                        placeholder={`https://...`}
                        value={data.mediaUrl || ''}
                        onChange={(e) => handleChange('mediaUrl', e.target.value)}
                     />
                </div>
            )}

            {/* Message Input */}
            <div>
                 <label className="text-[10px] font-bold text-gray-500 uppercase mb-1 block">
                    {isInputType ? "Question Text" : "Message Body"} <span className="text-red-500">*</span>
                 </label>
                 <textarea 
                    className={`w-full bg-gray-50 border rounded-lg p-3 text-sm text-gray-800 outline-none resize-none transition-all h-24
                        ${hasError && (!data.message || PLACEHOLDER_TEXTS.some(t => data.message?.toLowerCase().includes(t))) 
                            ? 'border-red-300 bg-red-50 focus:border-red-500' 
                            : 'border-gray-200 focus:border-blue-500 focus:bg-white focus:shadow-sm'}
                    `}
                    placeholder="Type your message..."
                    value={data.message}
                    onChange={(e) => handleChange('message', e.target.value)}
                 />
                 {/* Strict Warning Helper */}
                 {hasError && data.message && PLACEHOLDER_TEXTS.some(t => data.message.toLowerCase().includes(t)) && (
                     <p className="text-[10px] text-red-500 mt-1 font-bold">⚠️ Remove placeholder text</p>
                 )}
            </div>

            {/* Options Input */}
            {isOptionType && (
                <div>
                    <label className="text-[10px] font-bold text-gray-500 uppercase mb-1 block">Buttons / List Options</label>
                    <div className="space-y-2">
                        {options.map((opt, idx) => (
                            <div key={idx} className="flex items-center gap-2">
                                <div className="flex-1 flex items-center bg-gray-50 border border-gray-200 rounded-lg pl-3 pr-1 py-1.5 focus-within:ring-1 focus-within:ring-blue-500">
                                    <span className="text-[10px] text-gray-400 mr-2 font-mono">{idx + 1}</span>
                                    <input 
                                        value={opt}
                                        onChange={(e) => handleOptionChange(idx, e.target.value)}
                                        className="flex-1 bg-transparent border-none p-0 text-xs text-gray-700 outline-none"
                                        placeholder="Option label"
                                    />
                                    <button onClick={() => removeOption(idx)} className="p-1 text-gray-300 hover:text-red-400">
                                        <X size={12} />
                                    </button>
                                </div>
                                {/* Option Outlet */}
                                <Handle type="source" position={Position.Right} id={`opt_${idx}`} style={{...ACTIVE_HANDLE_STYLE, position: 'relative', transform: 'none', right: 0}} />
                            </div>
                        ))}
                    </div>
                    <button 
                        onClick={addOption}
                        className="mt-2 w-full py-2 border border-dashed border-gray-300 rounded-lg text-xs font-medium text-gray-500 hover:text-blue-600 hover:border-blue-400 hover:bg-blue-50 transition-all flex items-center justify-center gap-1"
                     >
                        <List size={12} /> Add Option
                     </button>
                </div>
            )}

            {/* Variable Save (Input Only) */}
            {isInputType && (
                 <div>
                    <label className="text-[10px] font-bold text-purple-600 uppercase mb-1 flex items-center gap-1">
                        <Hash size={10} /> Save Answer To
                    </label>
                    <select 
                        value={variableName}
                        onChange={(e) => {
                            setVariableName(e.target.value);
                            handleChange('saveToField', e.target.value);
                        }}
                        className="w-full bg-purple-50 border border-purple-100 text-purple-900 text-xs font-bold rounded-lg px-2 py-2 focus:ring-1 focus:ring-purple-500 outline-none cursor-pointer"
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
            )}
        </div>
        
        {/* Main Outlet (if not option type) */}
        {!isOptionType && (
            <Handle type="source" position={Position.Right} id="main" style={{...ACTIVE_HANDLE_STYLE, right: -12, top: '50%'}} />
        )}
    </div>
  );
};

const nodeTypes = {
  custom: CustomNode,
};

// --- DRAGGABLE COMPONENT ---
const DraggableSidebarItem = ({ type, inputType, label, icon }: any) => {
    const onDragStart = (event: React.DragEvent) => {
      event.dataTransfer.setData('application/reactflow/type', type);
      event.dataTransfer.setData('application/reactflow/inputType', inputType);
      event.dataTransfer.setData('application/reactflow/label', label);
      event.dataTransfer.effectAllowed = 'move';
    };
  
    return (
      <div 
        className="bg-white border border-gray-200 rounded-xl px-4 py-3 cursor-grab hover:shadow-md hover:border-blue-300 hover:bg-blue-50/50 transition-all flex items-center gap-3 group" 
        onDragStart={onDragStart} 
        draggable
      >
        <div className="p-2 bg-gray-100 rounded-lg text-gray-500 group-hover:bg-blue-100 group-hover:text-blue-600 transition-colors">
            {icon}
        </div>
        <span className="text-sm font-medium text-gray-700 group-hover:text-blue-800">{label}</span>
        <GripVertical size={14} className="ml-auto text-gray-300" />
      </div>
    );
};

// --- MAIN BUILDER ---

interface BotBuilderProps {
    isLiveMode?: boolean; 
}

export const BotBuilder: React.FC<BotBuilderProps> = ({ isLiveMode = false }) => {
  return (
    <ReactFlowProvider>
        <FlowEditor isLiveMode={isLiveMode} />
    </ReactFlowProvider>
  );
};

const FlowEditor = ({ isLiveMode }: { isLiveMode: boolean }) => {
  // Use Global Store
  const { 
      nodes, edges, onNodesChange, onEdgesChange, onConnect, 
      setNodes, setEdges, addNode, updateNodeData 
  } = useFlowStore();
  
  const [isSaving, setIsSaving] = useState(false);
  const reactFlowInstance = useReactFlow();

  // Load Data
  useEffect(() => {
    const load = async () => {
        let settings: BotSettings;
        if (isLiveMode) {
             try { settings = await liveApiService.getBotSettings(); } catch(e) { return; }
        } else {
             settings = mockBackend.getBotSettings();
        }

        if (settings.flowData && settings.flowData.nodes.length > 0) {
            
            // --- AUTO-CLEAN OLD DATA ---
            // If we find placeholders in loaded data, we wipe them so the user is forced to fix them.
            const cleanedNodes = settings.flowData.nodes.map((n: any) => {
                const newData = { ...n.data };
                // Using regex for consistent client-side cleaning
                const BLOCKED_REGEX = /replace\s+this\s+sample\s+message|enter\s+your\s+message|type\s+your\s+message\s+here|replace\s+this\s+text/i;
                if (newData.message && BLOCKED_REGEX.test(newData.message)) {
                    console.log(`Auto-cleaned node ${n.id}`);
                    newData.message = ""; // Empty it out
                    newData.hasError = true;
                    newData.errorMessage = "Placeholder Removed";
                }
                return { ...n, data: newData };
            });

            setNodes(cleanedNodes);
            setEdges(settings.flowData.edges);
        }
    };
    load();
  }, [isLiveMode, setNodes, setEdges]);

  // Drag & Drop
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

      if (!type) return;

      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const newNode: Node = {
        id: `node_${Date.now()}`,
        type: 'custom',
        position,
        data: { 
            label: label,
            message: '', // STRICTLY EMPTY
            inputType: inputType || 'text', 
            // Dynamic Icon based on label for header
            icon: undefined, 
            options: inputType === 'option' ? ['Yes', 'No'] : undefined,
            hasError: true, // Default to error state until filled
            errorMessage: 'Required'
        },
      };

      addNode(newNode);
    },
    [reactFlowInstance, addNode],
  );

  // --- STRICT SAVE VALIDATION ---
  const handleSave = async () => {
      let hasValidationErrors = false;
      
      const newNodes = nodes.map(node => {
          if (node.data.type === 'start') return node;
          
          let error = false;
          let errorMsg = '';
          const { label, message, mediaUrl, inputType, options } = node.data;
          
          // 1. Placeholder & Empty Check
          if (label === 'Text' || inputType === 'option' || inputType === 'text') {
             const BLOCKED_REGEX = /replace\s+this\s+sample\s+message|enter\s+your\s+message|type\s+your\s+message\s+here|replace\s+this\s+text/i;
             if (!message || !message.trim()) {
                 error = true;
                 errorMsg = 'Empty Message';
             } else if (BLOCKED_REGEX.test(message)) {
                 error = true;
                 errorMsg = 'Placeholder Detected';
             }
          }

          // 2. Media Check
          if ((label === 'Image' || label === 'Video') && (!mediaUrl || !mediaUrl.trim())) {
              error = true;
              errorMsg = 'Missing URL';
          }

          // 3. Option Check
          if (inputType === 'option' && (!options || options.length === 0)) {
              error = true;
              errorMsg = 'No Options';
          }

          if (error) hasValidationErrors = true;
          return { ...node, data: { ...node.data, hasError: error, errorMessage: errorMsg } };
      });

      if (hasValidationErrors) {
          setNodes(newNodes);
          alert("❌ SAVE BLOCKED: Strict Validation Failed.\n\nPlease fix red nodes. Ensure no 'Replace this sample message' text remains.");
          return;
      }

      setIsSaving(true);
      
      // Compiler: Nodes -> BotStep[]
      const compiledSteps: BotStep[] = [];
      nodes.forEach(node => {
          if (node.data.type === 'start') return;
          const outgoingEdges = edges.filter(e => e.source === node.id);
          let nextStepId = 'END';
          if (outgoingEdges.length > 0) nextStepId = outgoingEdges[0].target;

          compiledSteps.push({
            id: node.id,
            title: node.data.label,
            message: node.data.message,
            inputType: node.data.inputType,
            options: node.data.options,
            saveToField: node.data.saveToField,
            nextStepId: nextStepId,
            mediaUrl: node.data.mediaUrl
          });
      });

      const newSettings: BotSettings = {
          ...mockBackend.getBotSettings(),
          steps: compiledSteps,
          flowData: { nodes, edges } 
      };

      try {
          if (isLiveMode) await liveApiService.saveBotSettings(newSettings);
          else mockBackend.updateBotSettings(newSettings);
      } catch(e) {
          alert("Save Failed");
      }
      
      setTimeout(() => setIsSaving(false), 500);
  };

  return (
    <div className="flex h-full bg-gray-50 font-sans">
        
        {/* Sidebar (Tools) */}
        <div className="w-72 bg-white border-r border-gray-200 flex flex-col z-10 shadow-lg">
            <div className="p-5 border-b border-gray-100">
                <div className="flex items-center gap-2 mb-1">
                    <Zap className="text-yellow-500 fill-yellow-500" size={20} />
                    <h2 className="font-bold text-gray-900">Flow Builder</h2>
                </div>
                <p className="text-xs text-gray-500">Drag nodes to canvas</p>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-6">
                <div>
                    <h4 className="text-xs font-bold text-gray-400 uppercase mb-3 tracking-wider">Messaging</h4>
                    <div className="space-y-2">
                        <DraggableSidebarItem type="text" label="Text Message" icon={<MessageSquare size={16} />} />
                        <DraggableSidebarItem type="image" label="Image" icon={<ImageIcon size={16} />} />
                        <DraggableSidebarItem type="video" label="Video" icon={<Video size={16} />} />
                    </div>
                </div>

                <div>
                    <h4 className="text-xs font-bold text-gray-400 uppercase mb-3 tracking-wider">Questions</h4>
                    <div className="space-y-2">
                        <DraggableSidebarItem type="option" inputType="option" label="Buttons / List" icon={<List size={16} />} />
                        <DraggableSidebarItem type="input" inputType="text" label="Collect Text" icon={<Type size={16} />} />
                        <DraggableSidebarItem type="input" inputType="text" label="Collect Number" icon={<Hash size={16} />} />
                    </div>
                </div>
            </div>
        </div>

        {/* Canvas Area */}
        <div className="flex-1 relative flex flex-col h-full overflow-hidden">
            {/* Toolbar */}
            <div className="absolute top-4 right-4 z-20 flex gap-3">
                 <button 
                    onClick={handleSave}
                    disabled={isSaving}
                    className="bg-black text-white px-5 py-2.5 rounded-full text-sm font-bold shadow-lg hover:bg-gray-800 transition-all flex items-center gap-2"
                 >
                    {isSaving ? <span className="animate-spin"><Zap size={16} /></span> : <CheckCircle size={16} />}
                    {isSaving ? 'Validating...' : 'Publish Flow'}
                 </button>
            </div>

            <div className="flex-1 h-full bg-slate-50" onDragOver={onDragOver} onDrop={onDrop}>
                 <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    nodeTypes={nodeTypes}
                    defaultViewport={{ x: 0, y: 0, zoom: 0.8 }}
                    minZoom={0.2}
                    maxZoom={1.5}
                    attributionPosition="bottom-right"
                    proOptions={{ hideAttribution: true }}
                 >
                    <Background color="#cbd5e1" gap={20} size={1} variant="dots" />
                    <Controls className="bg-white border border-gray-200 shadow-xl rounded-lg p-1" />
                    <MiniMap 
                        className="border border-gray-200 rounded-lg shadow-xl" 
                        nodeColor={(n) => n.type === 'start' ? '#10b981' : '#3b82f6'} 
                        maskColor="rgba(240, 242, 245, 0.7)"
                    />
                    
                    {/* Floating Helper */}
                    <Panel position="bottom-center" className="mb-8">
                        <div className="bg-white/90 backdrop-blur border border-gray-200 px-4 py-2 rounded-full text-xs text-gray-500 shadow-sm flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-green-500"></span>
                            Strict Mode Active: Placeholders Blocked
                        </div>
                    </Panel>
                 </ReactFlow>
            </div>
        </div>
    </div>
  );
};
