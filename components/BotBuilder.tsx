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
import { 
  Save, MessageSquare, Image as ImageIcon, Video, FileText, MapPin, 
  List, Type, Hash, Mail, Globe, Calendar, Clock, Phone, 
  CreditCard, ShoppingBag, LayoutGrid, MoreHorizontal, X, Copy, Trash2,
  ChevronDown, ChevronRight, Zap, Play, CheckCircle
} from 'lucide-react';

// --- STYLES & CONSTANTS ---
const HANDLE_STYLE = { width: 10, height: 10, background: '#3b82f6', border: '2px solid white' };

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

  // Determine Node Styling based on Type
  const isStartNode = data.type === 'start';

  if (isStartNode) {
    return (
      <div className={`px-6 py-4 bg-white rounded-2xl shadow-md border-2 min-w-[200px] flex items-center gap-3 ${selected ? 'border-blue-500' : 'border-gray-100'}`}>
        <div className="p-2 bg-gray-100 rounded-lg text-gray-600">
           <Zap size={20} fill="currentColor" className="text-yellow-500" />
        </div>
        <div>
           <h3 className="font-bold text-gray-900">Start</h3>
           <p className="text-xs text-gray-400">Entry Point</p>
        </div>
        <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
      </div>
    );
  }

  return (
    <div className={`w-[320px] bg-white rounded-2xl shadow-xl border-2 transition-all duration-200 group ${selected ? 'border-blue-500 ring-4 ring-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
      
      {/* Target Handle (Input) */}
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} className="-left-2.5" />

      {/* Header */}
      <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between bg-white rounded-t-2xl">
        <div className="flex items-center gap-2">
           <span className="text-xs font-bold text-gray-900">Group #{id.split('_')[1] || id}</span>
        </div>
        <div className="flex gap-1">
            <button onClick={() => data.onDelete?.(id)} className="text-gray-400 hover:text-red-500 transition-colors p-1">
                <Trash2 size={14} />
            </button>
            <button className="text-gray-400 hover:text-gray-600 transition-colors p-1">
                <MoreHorizontal size={14} />
            </button>
        </div>
      </div>

      {/* Body */}
      <div className="p-5 space-y-4 bg-white rounded-b-2xl">
        
        {/* Prompt Card (Yellowish like screenshot) */}
        <div className="bg-amber-50 rounded-xl p-4 border border-amber-100 relative group/prompt">
           <div className="flex items-center gap-2 mb-2">
              {data.icon}
              <span className="text-xs font-bold text-amber-800 uppercase tracking-wide">{data.label}</span>
           </div>
           
           <textarea 
             className="w-full bg-transparent border-none p-0 text-sm font-medium text-gray-800 placeholder-amber-800/40 focus:ring-0 resize-none leading-relaxed"
             rows={3}
             placeholder={`Enter ${data.label.toLowerCase()} message...`}
             value={data.message}
             onChange={(e) => handleChange('message', e.target.value)}
           />

           {/* Media Attachment Indicator */}
           {data.hasMedia && (
             <div className="mt-2 pt-2 border-t border-amber-200/50 flex items-center gap-2 text-amber-700 text-xs font-medium">
               <ImageIcon size={12} />
               <span>Media Attachment Enabled</span>
             </div>
           )}
           
           <Handle type="source" position={Position.Right} id="main" style={{...HANDLE_STYLE, right: -26, top: '50%'}} />
        </div>

        {/* Dynamic Options (For Choice/List types) */}
        {data.inputType === 'option' && (
           <div className="space-y-2">
             {options.map((opt, idx) => (
               <div key={idx} className="relative group/opt">
                  <div className="flex items-center bg-white border border-gray-200 rounded-lg pl-3 pr-1 py-2 shadow-sm focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-transparent">
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
                  {/* Handle for this specific option */}
                  <Handle 
                    type="source" 
                    position={Position.Right} 
                    id={`opt_${idx}`} // Unique ID for connecting specific buttons
                    style={{...HANDLE_STYLE, right: -12}}
                  />
               </div>
             ))}
             <button 
                onClick={addOption}
                className="w-full py-2 border border-dashed border-gray-300 rounded-lg text-xs font-medium text-gray-500 hover:text-blue-600 hover:border-blue-400 hover:bg-blue-50 transition-all flex items-center justify-center gap-1"
             >
                <List size={12} /> Add Choice
             </button>
           </div>
        )}

        {/* Variable Capture (Purple Pill) */}
        {(data.inputType !== 'option' || data.saveToField) && (
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
                    className="w-full pl-8 pr-3 py-2.5 bg-purple-50 border border-purple-100 text-purple-900 text-xs font-bold rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent outline-none appearance-none cursor-pointer"
                >
                    <option value="">Select variable to save answer...</option>
                    <option value="name">user_name</option>
                    <option value="vehicleRegistration">vehicle_number</option>
                    <option value="availability">availability_status</option>
                    <option value="document">uploaded_document_url</option>
                </select>
                <div className="absolute inset-y-0 right-3 flex items-center pointer-events-none">
                     <span className="text-[10px] bg-purple-200 text-purple-800 px-1.5 py-0.5 rounded">VAR</span>
                </div>
            </div>
        )}

      </div>
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
            { type: 'input', inputType: 'text', label: 'Phone', icon: <Phone size={16} /> },
        ]
    },
    {
        title: 'Payments',
        items: [
            { type: 'payment', label: 'Payment Link', icon: <CreditCard size={16} /> },
        ]
    },
    {
        title: 'Ecommerce',
        items: [
            { type: 'catalog', label: 'Catalog', icon: <ShoppingBag size={16} /> },
            { type: 'status', label: 'Order Status', icon: <CheckCircle size={16} /> },
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
  const reactFlowInstance = useReactFlow();

  // Load Data
  useEffect(() => {
    const load = async () => {
        let settings: BotSettings;
        if (isLiveMode) {
             try {
                settings = await liveApiService.getBotSettings();
             } catch(e) { return; }
        } else {
             settings = mockBackend.getBotSettings();
        }

        if (settings.flowData && settings.flowData.nodes.length > 0) {
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
        style: { stroke: '#94a3b8', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' } 
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

      // Icon Reconstruction (Simplified)
      let icon = <MessageSquare size={16} className="text-amber-700" />;
      if(label === 'Image') icon = <ImageIcon size={16} className="text-amber-700" />;
      if(inputType === 'option') icon = <List size={16} className="text-amber-700" />;

      const newNode: Node = {
        id: `node_${Date.now()}`,
        type: 'custom',
        position,
        data: { 
            label: label,
            icon: icon,
            message: '', 
            inputType: inputType || 'text', 
            hasMedia: type === 'image' || type === 'video',
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
      
      // Compiler: Visual Graph -> Execution Linear Steps
      const compiledSteps: BotStep[] = [];
      
      // 1. Find Start Node
      const startNode = nodes.find(n => n.data.type === 'start');
      let currentId = startNode?.id;

      // 2. Simple Traversal (Heuristic: Convert all nodes to steps)
      nodes.forEach(node => {
          if (node.data.type === 'start') return;

          // Find connections FROM this node
          const outgoingEdges = edges.filter(e => e.source === node.id);
          
          let nextStepId = 'END';
          // If connection from main handle
          const mainEdge = outgoingEdges.find(e => e.sourceHandle === 'main' || !e.sourceHandle);
          if (mainEdge) nextStepId = mainEdge.target;
          else if (outgoingEdges.length > 0) nextStepId = outgoingEdges[0].target; // Fallback

          // Note: Full branching support in backend requires complex graph engine.
          // For now, we assume linear nextStepId or AI Handoff. 
          // If multiple branches exist, the backend 'options' logic will handle it if the nextStepId matches the flow order.

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
                    <span className="font-bold text-gray-900">Ecom Bot</span>
                </div>
                
                {/* Toggles */}
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-600">Static Variables</span>
                        <div className="w-9 h-5 bg-green-500 rounded-full relative cursor-pointer">
                            <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-400">Global Variables</span>
                        <div className="w-9 h-5 bg-gray-200 rounded-full relative cursor-pointer">
                            <div className="absolute left-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="flex items-center gap-4">
                 <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-400">Autosave</span>
                    <div className="w-8 h-4 bg-gray-200 rounded-full relative cursor-pointer">
                         <div className="absolute left-0.5 top-0.5 w-3 h-3 bg-white rounded-full shadow-sm"></div>
                    </div>
                 </div>
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
                    {/* Dot Pattern Background matching screenshot */}
                    <Background color="#e2e8f0" gap={24} size={2} />
                    <Controls className="bg-white border border-gray-200 shadow-sm rounded-lg p-1 m-4" />
                    <MiniMap className="border border-gray-200 rounded-lg shadow-sm m-4" zoomable pannable />
                 </ReactFlow>
            </div>

            {/* RIGHT SIDEBAR */}
            <div className="w-[300px] bg-white border-l border-gray-200 flex flex-col shadow-xl z-10 overflow-hidden">
                <div className="flex-1 overflow-y-auto custom-scrollbar">
                    <div className="p-4 space-y-6">
                        {SIDEBAR_CATEGORIES.map((cat, idx) => (
                            <div key={idx}>
                                <h4 className="text-xs font-bold text-gray-900 mb-3 ml-1">{cat.title}</h4>
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
        <div className="bg-white border border-gray-200 border-dashed hover:border-solid hover:border-blue-500 rounded-xl p-3 flex items-center gap-3 transition-all hover:shadow-md hover:-translate-y-0.5">
            <div className="text-gray-400 group-hover:text-blue-500 transition-colors">
                {icon}
            </div>
            <span className="text-sm font-medium text-gray-600 group-hover:text-gray-900">{label}</span>
        </div>
      </div>
    );
};