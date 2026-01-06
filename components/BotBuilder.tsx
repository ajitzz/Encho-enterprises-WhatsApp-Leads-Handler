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
  ReactFlowProvider,
  useReactFlow,
  MarkerType
} from '@xyflow/react';
import { BotSettings, BotStep } from '../types';
import { mockBackend } from '../services/mockBackend';
import { liveApiService } from '../services/liveApiService';
import { 
  MessageSquare, Image as ImageIcon, Video, FileText, MapPin, 
  List, Type, Hash, Mail, Globe, Calendar, Clock, 
  LayoutGrid, X, Trash2, Zap, CheckCircle, Flag, Pencil, Bold, Italic, Link, Play, AlertTriangle, ShieldAlert
} from 'lucide-react';

// --- STYLES & CONSTANTS ---
const HANDLE_STYLE = { width: 8, height: 8, background: '#9ca3af', border: '2px solid white' };
const ACTIVE_HANDLE_STYLE = { width: 10, height: 10, background: '#3b82f6', border: '2px solid white' };

// --- HELPER: Get Icon dynamically ---
const getNodeIcon = (label: string, inputType?: string) => {
    if (label === 'Image') return <ImageIcon size={14} />;
    if (label === 'Video') return <Video size={14} />;
    if (label === 'File') return <FileText size={14} />;
    if (label === 'Location') return <MapPin size={14} />;
    if (inputType === 'option' || label === 'List' || label === 'Quick Reply') return <List size={14} />;
    if (label === 'Link') return <Link size={14} />;
    if (label === 'Email') return <Mail size={14} />;
    if (label === 'Number') return <Hash size={14} />;
    if (label === 'Website') return <Globe size={14} />;
    if (label === 'Date') return <Calendar size={14} />;
    if (label === 'Time') return <Clock size={14} />;
    return <MessageSquare size={14} />;
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
  
  // Error State Detection
  const hasError = data.hasError;

  // --- 2. EDIT MODE (Selected) ---
  if (selected) {
    return (
        <div className={`w-[400px] bg-white rounded-xl shadow-2xl border-2 ${hasError ? 'border-red-500 ring-4 ring-red-50' : 'border-blue-500 ring-4 ring-blue-50'} transition-all duration-200 z-50 relative animate-in zoom-in-95 duration-200`}>
             <Handle type="target" position={Position.Left} style={HANDLE_STYLE} className="-left-2.5" />
             
             {hasError && (
                 <div className="absolute -top-3 left-4 bg-red-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 shadow-sm">
                     <AlertTriangle size={10} /> {data.errorMessage || "Validation Error"}
                 </div>
             )}

             <div className="p-4">
                {/* --- MEDIA TYPES (Image, Video, File) --- */}
                {isMediaType && (
                    <>
                        <div className="flex items-center gap-4 mb-4">
                            <span className="text-sm font-bold text-gray-800 bg-gray-100 px-3 py-1.5 rounded-md flex items-center gap-1">
                                {data.label} URL <span className="text-red-500">*</span>
                            </span>
                        </div>

                        <div className="relative mb-4 group/input">
                            <input 
                                type="text" 
                                className={`w-full border rounded-lg py-2.5 pl-3 pr-9 text-sm text-gray-700 outline-none transition-colors ${!data.mediaUrl && hasError ? 'border-red-300 bg-red-50 placeholder-red-300' : 'border-gray-200 focus:border-green-500'}`}
                                placeholder={`Paste ${data.label.toLowerCase()} link here...`}
                                value={data.mediaUrl || ''}
                                onChange={(e) => handleChange('mediaUrl', e.target.value)}
                            />
                        </div>

                        {(data.label === 'Image' || data.label === 'Video') && (
                            <div className="relative group/caption">
                                <label className="block text-sm font-medium text-gray-900 mb-2">Caption (Optional):</label>
                                <textarea 
                                    className="w-full border border-gray-200 rounded-lg py-2.5 pl-3 pr-9 text-sm text-gray-700 outline-none focus:border-green-500 transition-colors resize-none bg-white"
                                    rows={2}
                                    placeholder="Add a caption..."
                                    value={data.message || ''}
                                    onChange={(e) => handleChange('message', e.target.value)}
                                />
                            </div>
                        )}
                    </>
                )}

                {/* --- TEXT TYPE --- */}
                {(data.label === 'Text') && (
                    <div className={`rounded-xl border ${hasError ? 'border-red-500 bg-red-50/10' : 'border-green-500 ring-1 ring-green-100'} transition-all duration-200`}>
                        <div className="p-4 relative">
                            <textarea 
                                className="w-full bg-transparent border-none p-0 text-sm text-gray-800 placeholder-gray-300 focus:ring-0 resize-none leading-relaxed font-medium"
                                rows={4}
                                placeholder="Enter your message here..."
                                value={data.message}
                                onChange={(e) => handleChange('message', e.target.value)}
                            />
                        </div>
                    </div>
                )}

                {/* --- CHOICE TYPES --- */}
                {isOptionType && (
                    <div className="space-y-3">
                         <div className={`p-3 rounded-lg border ${hasError && !data.message ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-gray-50'} mb-3`}>
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
                        <div className={`p-3 rounded-lg border ${hasError && !data.message ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-gray-50'}`}>
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

             {!isOptionType && (
                 <Handle type="source" position={Position.Right} id="main" style={{...ACTIVE_HANDLE_STYLE, right: -12, top: '50%'}} />
             )}
        </div>
    );
  }

  // --- 3. PREVIEW MODE (Unselected) ---
  return (
    <div className={`w-[280px] bg-white rounded-2xl shadow-md border transition-all hover:shadow-lg group relative cursor-pointer ${hasError ? 'border-red-500 ring-2 ring-red-100' : 'border-gray-200 hover:border-gray-300'}`}>
        <Handle type="target" position={Position.Left} style={HANDLE_STYLE} className="-left-2.5" />
        
        {/* Error Indicator */}
        {hasError && (
             <div className="absolute -top-3 -right-2 bg-red-600 text-white px-2 py-1 rounded-full shadow-md z-10 flex items-center gap-1">
                <ShieldAlert size={12} />
                <span className="text-[10px] font-bold">Fix Me</span>
             </div>
        )}

        {/* Header */}
        <div className={`px-4 py-3 border-b flex items-center justify-between ${hasError ? 'bg-red-50 border-red-100' : 'border-gray-100'}`}>
            <div className="flex items-center gap-2">
                <span className={`${hasError ? 'text-red-500' : 'text-gray-500'}`}>
                    {getNodeIcon(data.label, data.inputType)}
                </span>
                <span className={`text-xs font-bold ${hasError ? 'text-red-800' : 'text-gray-900'}`}>{data.label}</span>
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
                <p className={`text-sm line-clamp-3 font-medium ${hasError ? 'text-red-600' : 'text-gray-600'}`}>
                    {data.message || "Message required"}
                </p>
            )}

            {/* Media Preview */}
            {(data.label === 'Image' || data.label === 'Video') && (
                <div className="space-y-2">
                     <div className={`relative aspect-video rounded-lg overflow-hidden border ${!data.mediaUrl && hasError ? 'border-red-300 bg-red-50' : 'bg-gray-100 border-gray-100'}`}>
                        {data.mediaUrl ? (
                            <div className="w-full h-full flex items-center justify-center bg-black text-white text-xs">
                                {data.label === 'Video' ? <Play size={20} /> : <ImageIcon size={20} />}
                            </div>
                        ) : (
                            <div className="flex items-center justify-center h-full text-red-300">
                                <AlertTriangle size={24} />
                            </div>
                        )}
                     </div>
                </div>
            )}

             {/* Choices Preview */}
             {isOptionType && (
                <div className="space-y-2">
                    <p className={`text-xs mb-2 ${hasError ? 'text-red-600 font-bold' : 'text-gray-600'}`}>
                        {data.message || "Question text required"}
                    </p>
                    <div className="flex flex-col gap-1.5">
                        {options.map((opt, i) => (
                            <div key={i} className="w-full bg-gray-50 border border-gray-200 text-gray-600 py-1.5 px-3 rounded text-xs font-medium text-center relative">
                                {opt}
                            </div>
                        ))}
                        {options.length === 0 && <span className="text-xs text-red-400 italic font-bold">Add at least one option</span>}
                    </div>
                </div>
             )}
        </div>

        {!isOptionType && (
            <Handle type="source" position={Position.Right} id="main" style={{...ACTIVE_HANDLE_STYLE, right: -12, top: '50%'}} />
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
  const reactFlowInstance = useReactFlow();

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
            const restoredNodes = settings.flowData.nodes.map((n: any) => ({
                ...n,
                data: {
                    ...n.data,
                    icon: undefined, 
                    onChange: updateNodeData,
                    onDelete: deleteNode,
                    hasError: false // Reset visual errors on load
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

      const newNode: Node = {
        id: `node_${Date.now()}`,
        type: 'custom',
        position,
        data: { 
            label: label,
            message: '', 
            inputType: inputType || 'text', 
            hasMedia: type === 'image' || type === 'video' || type === 'file',
            onChange: updateNodeData, 
            onDelete: deleteNode,
            options: inputType === 'option' ? ['Yes', 'No'] : undefined,
            hasError: false
        },
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [reactFlowInstance],
  );

  // --- STRICT VALIDATION ---
  const handleSave = async () => {
      let hasValidationErrors = false;
      
      // Update nodes to show error state if invalid
      const newNodes = nodes.map(node => {
          if (node.data.type === 'start') return node;
          
          let error = false;
          let errorMsg = '';
          const { label, message, mediaUrl, inputType, options } = node.data;
          
          // 1. TEXT / QUESTION VALIDATION
          if ((label === 'Text' || inputType === 'option' || inputType === 'text')) {
             if (!message || !message.trim()) {
                 error = true;
                 errorMsg = 'Message cannot be empty';
             } else if (message.toLowerCase().includes('replace this sample message')) {
                 error = true;
                 errorMsg = 'REMOVE PLACEHOLDER TEXT';
             } else if (message.toLowerCase().includes('enter your message')) {
                 error = true;
                 errorMsg = 'REMOVE PLACEHOLDER TEXT';
             }
          }

          // 2. MEDIA VALIDATION
          if ((label === 'Image' || label === 'Video') && (!mediaUrl || !mediaUrl.trim())) {
              error = true;
              errorMsg = 'Media URL required';
          }

          // 3. OPTIONS VALIDATION
          if (inputType === 'option' && (!options || options.length === 0)) {
              error = true;
              errorMsg = 'Add at least 1 option';
          }

          if (error) hasValidationErrors = true;
          
          return {
              ...node,
              data: { ...node.data, hasError: error, errorMessage: errorMsg }
          };
      });

      if (hasValidationErrors) {
          setNodes(newNodes);
          alert("Cannot Save: Validation Failed.\n\nPlease remove all 'Replace this sample message' placeholders and ensure all fields are filled.");
          return;
      }

      // Proceed with Save
      setIsSaving(true);
      const compiledSteps: BotStep[] = [];
      
      nodes.forEach(node => {
          if (node.data.type === 'start') return;

          const outgoingEdges = edges.filter(e => e.source === node.id);
          let nextStepId = 'END';
          if (outgoingEdges.length > 0) {
              nextStepId = outgoingEdges[0].target;
          }

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

      if (isLiveMode) {
          try {
             await liveApiService.saveBotSettings(newSettings);
          } catch(e) { 
             console.error("Save failed", e);
             alert("Failed to save to live server.");
          }
      } else {
          mockBackend.updateBotSettings(newSettings);
      }
      
      setTimeout(() => setIsSaving(false), 800);
  };

  return (
    <div className="flex flex-col h-full bg-gray-50 font-sans">
        <div className="bg-white border-b border-gray-200 px-6 h-16 flex items-center justify-between shrink-0 z-20">
            <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                    <div className="w-8 h-8 bg-gray-900 rounded-full flex items-center justify-center text-white">
                        <Zap size={16} fill="currentColor" />
                    </div>
                    <span className="font-bold text-gray-900">My Chatbot</span>
                </div>
            </div>

            <div className="flex items-center gap-4">
                 <button 
                    onClick={handleSave}
                    disabled={isSaving}
                    className="bg-green-500 hover:bg-green-600 text-white px-6 py-2 rounded-full text-sm font-bold shadow-md hover:shadow-lg transition-all flex items-center gap-2"
                 >
                    {isSaving ? <span className="animate-pulse">Saving...</span> : <><CheckCircle size={16} /> Save Changes</>}
                 </button>
            </div>
        </div>

        <div className="flex-1 flex overflow-hidden relative">
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
      <div className="flex flex-col gap-2 cursor-grab group" onDragStart={onDragStart} draggable>
        <div className="bg-white border border-dashed border-gray-200 rounded-xl px-3 py-3 flex items-center gap-3 transition-all hover:border-green-400 hover:bg-green-50/30 hover:shadow-sm">
            <div className="text-green-600">{icon}</div>
            <span className="text-sm font-medium text-gray-700">{label}</span>
        </div>
      </div>
    );
};
