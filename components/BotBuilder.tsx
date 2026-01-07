
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { 
  ReactFlow, 
  MiniMap, 
  Controls, 
  Background, 
  BackgroundVariant,
  Handle, 
  Position,
  Node,
  ReactFlowProvider,
  useReactFlow,
  Panel,
  Connection,
  Edge,
  useNodesState,
  useEdgesState,
  addEdge
} from '@xyflow/react';
import { BotSettings, BotStep } from '../types';
import { mockBackend } from '../services/mockBackend';
import { liveApiService } from '../services/liveApiService';
import { useFlowStore } from '../services/flowStore'; 
import { auditBotFlow, analyzeSystemCode } from '../services/geminiService';
import { 
  MessageSquare, Image as ImageIcon, Video, List, Type, Hash, 
  LayoutGrid, X, Trash2, Zap, CheckCircle, Flag, ShieldAlert, 
  GripVertical, MousePointerClick, FileCode, Brush, Eye, 
  ChevronRight, Folder, ArrowLeft, Search, Cloud, Plus
} from 'lucide-react';

// --- STYLES ---
const HANDLE_STYLE = { width: 8, height: 8, background: '#94a3b8', border: '2px solid white', zIndex: 50 };
const ACTIVE_HANDLE_STYLE = { width: 10, height: 10, background: '#3b82f6', border: '2px solid white', zIndex: 50 };

// --- CONSTANTS ---
const SYSTEM_TEMPLATES = [
    'hello_world',
    'sample_shipping_confirmation',
    'sample_movie_ticket_confirmation',
    'sample_purchase_feedback',
    'sample_issue_resolution',
    'sample_flight_confirmation',
    'sample_happy_hour_announcement'
];

// --- HELPER: GET ICON ---
// Prevents storing React Elements in Node Data (Causes JSON Error #31)
const getIconForLabel = (label: string) => {
    switch(label) {
        case 'Image': return <ImageIcon size={14} />;
        case 'Video': return <Video size={14} />;
        case 'Quick Reply': 
        case 'List': return <List size={14} />;
        case 'Collect Text': return <Type size={14} />;
        default: return <MessageSquare size={14} />;
    }
};

// --- MEDIA PICKER COMPONENT ---
interface MediaPickerProps {
    onSelect: (url: string) => void;
    onClose: () => void;
    type: 'image' | 'video' | 'file';
}

const MediaPicker: React.FC<MediaPickerProps> = ({ onSelect, onClose, type }) => {
    const [folders, setFolders] = useState<any[]>([]);
    const [files, setFiles] = useState<any[]>([]);
    const [currentPath, setCurrentPath] = useState('/');
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        loadMedia(currentPath);
    }, [currentPath]);

    const loadMedia = async (path: string) => {
        setLoading(true);
        try {
            // Check if live mode available, else fallback to empty or mock
            const data = await liveApiService.getMediaLibrary(path);
            setFolders(data.folders);
            setFiles(data.files.filter((f: any) => type === 'file' ? true : f.type === type));
        } catch (e) {
            console.error("Media load failed", e);
        } finally {
            setLoading(false);
        }
    };

    const navigateUp = () => {
        if (currentPath === '/') return;
        const parts = currentPath.split('/').filter(Boolean);
        parts.pop();
        setCurrentPath(parts.length === 0 ? '/' : '/' + parts.join('/'));
    };

    return (
        <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl h-[600px] flex flex-col overflow-hidden animate-in zoom-in-95">
                <div className="p-4 border-b border-gray-100 flex justify-between items-center bg-gray-50">
                    <div className="flex items-center gap-3">
                        <button onClick={onClose} className="p-1 hover:bg-gray-200 rounded-full"><X size={20} /></button>
                        <h3 className="font-bold text-gray-800 flex items-center gap-2">
                            <Cloud size={18} className="text-blue-600" /> Select {type === 'image' ? 'Image' : 'Video'}
                        </h3>
                    </div>
                </div>
                
                {/* Breadcrumb */}
                <div className="px-4 py-2 bg-white border-b border-gray-100 flex items-center gap-2 text-sm text-gray-600">
                    <button onClick={navigateUp} disabled={currentPath === '/'} className="p-1 hover:bg-gray-100 rounded disabled:opacity-30">
                        <ArrowLeft size={14} />
                    </button>
                    <span className="font-mono bg-gray-100 px-2 py-0.5 rounded">{currentPath}</span>
                </div>

                <div className="flex-1 overflow-y-auto p-4 bg-gray-50/50">
                    {loading ? (
                        <div className="h-full flex items-center justify-center"><div className="animate-spin w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full"></div></div>
                    ) : (
                        <div className="grid grid-cols-4 gap-4">
                            {/* Folders */}
                            {folders.map(f => (
                                <button key={f.id} onClick={() => setCurrentPath(currentPath === '/' ? `/${f.name}` : `${currentPath}/${f.name}`)} className="flex flex-col items-center justify-center p-4 bg-white border border-gray-200 rounded-xl hover:border-blue-400 hover:shadow-sm transition-all h-32">
                                    <Folder size={32} className="text-yellow-400 fill-yellow-100 mb-2" />
                                    <span className="text-xs font-medium text-gray-700 truncate w-full text-center">{f.name}</span>
                                </button>
                            ))}
                            
                            {/* Files */}
                            {files.map(f => (
                                <button key={f.id} onClick={() => { onSelect(f.url); onClose(); }} className="relative group flex flex-col bg-white border border-gray-200 rounded-xl hover:border-blue-500 hover:ring-2 hover:ring-blue-100 transition-all overflow-hidden h-32">
                                    {type === 'image' ? (
                                        <img src={f.url} className="w-full h-full object-cover" alt={f.filename} />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center bg-gray-900"><Video className="text-white" size={24} /></div>
                                    )}
                                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-end p-2">
                                        <span className="text-[10px] text-white bg-black/50 px-2 py-0.5 rounded truncate w-full">{f.filename}</span>
                                    </div>
                                </button>
                            ))}
                        </div>
                    )}
                    {!loading && folders.length === 0 && files.length === 0 && (
                        <div className="h-full flex flex-col items-center justify-center text-gray-400">
                            <Folder size={48} className="mb-2 opacity-20" />
                            <p>Folder is empty</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

// --- NODE PREVIEW CARD (THE CANVAS NODE) ---
const NodePreviewCard = ({ data, id, selected }: any) => {
  const isInputType = ['Text', 'Number', 'Email', 'Website', 'Date', 'Time'].includes(data.label);
  const isMediaType = ['Image', 'Video', 'File', 'Audio'].includes(data.label);
  const isOptionType = ['Quick Reply', 'List'].includes(data.label);
  const hasPlaceholder = data.message && /replace\s+this|enter\s+your/i.test(data.message);
  
  let borderColor = 'border-gray-200';
  let accentColor = 'bg-gray-50';
  let iconColor = 'text-gray-500';

  if (isMediaType) { borderColor = 'border-amber-200'; accentColor = 'bg-amber-50'; iconColor = 'text-amber-600'; }
  else if (isOptionType) { borderColor = 'border-purple-200'; accentColor = 'bg-purple-50'; iconColor = 'text-purple-600'; }
  else if (data.label === 'Text Message') { borderColor = 'border-blue-200'; accentColor = 'bg-blue-50'; iconColor = 'text-blue-600'; }

  if (selected) borderColor = 'border-blue-500 ring-2 ring-blue-100';
  if (hasPlaceholder) borderColor = 'border-red-500 ring-2 ring-red-100';

  if (data.type === 'start') {
      return (
        <div className={`w-[240px] shadow-sm rounded-xl bg-white border-2 transition-all ${selected ? 'border-green-500' : 'border-gray-100'}`}>
            <div className="bg-green-50 px-4 py-3 rounded-t-lg border-b border-green-100 flex items-center gap-2">
                <Flag size={16} className="text-green-600" />
                <span className="text-xs font-bold text-green-800 uppercase">Entry Point</span>
            </div>
            <div className="p-4 text-center text-xs text-gray-500">Flow starts here</div>
            <Handle type="source" position={Position.Right} style={ACTIVE_HANDLE_STYLE} className="-right-3" />
        </div>
      );
  }

  // Derive icon to avoid JSON Error #31
  const icon = getIconForLabel(data.label);

  return (
    <div className={`w-[280px] bg-white rounded-xl shadow-lg border-2 transition-all group ${borderColor}`}>
        <Handle type="target" position={Position.Left} style={HANDLE_STYLE} className="-left-3" />
        
        {/* Header */}
        <div className={`px-4 py-2.5 border-b flex items-center justify-between rounded-t-lg ${accentColor} ${borderColor}`}>
            <div className="flex items-center gap-2">
                <div className={`p-1 rounded ${iconColor} bg-white/50`}>{icon}</div>
                <span className={`text-xs font-bold uppercase ${iconColor}`}>{data.label}</span>
            </div>
            {hasPlaceholder && <ShieldAlert size={14} className="text-red-500 animate-pulse" />}
        </div>

        {/* Body */}
        <div className="p-3">
            {/* Media Preview */}
            {isMediaType && (
                <div className="mb-3 rounded-lg bg-gray-100 border border-gray-200 aspect-video overflow-hidden flex items-center justify-center relative">
                    {data.mediaUrl ? (
                        data.label === 'Video' ? <video src={data.mediaUrl} className="w-full h-full object-cover" /> : <img src={data.mediaUrl} className="w-full h-full object-cover" alt="preview" />
                    ) : (
                        <span className="text-[10px] text-gray-400 font-medium flex items-center gap-1"><ImageIcon size={12} /> No Asset Selected</span>
                    )}
                </div>
            )}

            {/* Message Text */}
            <p className={`text-xs line-clamp-3 mb-3 font-medium ${hasPlaceholder ? 'text-red-600' : 'text-gray-700'}`}>
                {data.message || <span className="italic text-gray-300">No message text...</span>}
            </p>

            {/* Interactive Options */}
            {isOptionType && (
                <div className="flex flex-col gap-1.5">
                    {data.options?.map((opt: string, i: number) => (
                        <div key={i} className="flex items-center justify-between bg-gray-50 border border-gray-200 px-2 py-1.5 rounded text-[10px] font-medium text-gray-600">
                            <span>{opt || '(Empty)'}</span>
                            <div className="w-1.5 h-1.5 rounded-full bg-purple-400"></div>
                        </div>
                    ))}
                </div>
            )}
            
            {/* Variable Save Indicator */}
            {data.saveToField && (
                <div className="mt-2 pt-2 border-t border-gray-100 flex items-center gap-1 text-[10px] text-purple-600 font-mono">
                    <Hash size={10} />
                    <span>Saves to: <strong>{data.saveToField}</strong></span>
                </div>
            )}
        </div>

        {/* Output Handles */}
        {isOptionType ? (
            <div className="absolute -right-3 top-[80px] bottom-4 flex flex-col justify-end gap-[18px]">
               {data.options?.map((_: any, i: number) => (
                   <Handle key={i} type="source" position={Position.Right} id={`opt_${i}`} style={{...ACTIVE_HANDLE_STYLE, position: 'relative', right: 0, transform: 'none'}} />
               ))}
            </div>
        ) : (
            <Handle type="source" position={Position.Right} id="main" style={ACTIVE_HANDLE_STYLE} className="-right-3" />
        )}
    </div>
  );
};

// --- PROPERTY INSPECTOR (RIGHT SIDEBAR) ---
const PropertyInspector = ({ selectedNode, onChange }: { selectedNode: Node, onChange: (id: string, data: any) => void }) => {
    const [localData, setLocalData] = useState<any>(selectedNode.data);
    const [showMediaPicker, setShowMediaPicker] = useState(false);

    useEffect(() => { setLocalData(selectedNode.data); }, [selectedNode]);

    const update = (field: string, value: any) => {
        const newData = { ...localData, [field]: value };
        // Clean out any icon if it exists to prevent saving bad data
        if (newData.icon) delete newData.icon;
        
        // Sanitize template name (prevent invalid values that break backend)
        if (field === 'templateName' && value) {
             const cleanVal = value.replace(/[^a-zA-Z0-9_]/g, '');
             newData[field] = cleanVal;
        }

        setLocalData(newData);
        onChange(selectedNode.id, newData);
    };

    if (localData.type === 'start') return <div className="p-6 text-center text-gray-400 text-sm">Start Node has no properties.</div>;

    const isMediaType = ['Image', 'Video'].includes(localData.label);
    const isOptionType = ['Quick Reply', 'List'].includes(localData.label);
    const isInputType = ['Text', 'Number'].includes(localData.label) || localData.inputType === 'text';
    const icon = getIconForLabel(localData.label);

    return (
        <div className="w-80 bg-white border-l border-gray-200 flex flex-col h-full shadow-xl z-20">
            {/* Header */}
            <div className="px-5 py-4 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <div className="p-1.5 bg-white border border-gray-200 rounded-md shadow-sm">{icon}</div>
                    <h3 className="font-bold text-gray-800">{localData.label}</h3>
                </div>
                <div className="px-2 py-0.5 bg-blue-100 text-blue-700 text-[10px] rounded font-bold uppercase tracking-wider">Node #{selectedNode.id.split('_')[1] || '01'}</div>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-6">
                
                {/* 1. MESSAGE TEXT */}
                <div className="space-y-2">
                    <label className="text-xs font-bold text-gray-500 uppercase flex justify-between">
                        Message Body
                        <span className="text-gray-300 font-normal">{localData.message?.length || 0} chars</span>
                    </label>
                    <textarea 
                        className="w-full h-32 p-3 bg-white border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none transition-shadow shadow-sm"
                        placeholder="Type the message sent to the user..."
                        value={localData.message}
                        onChange={(e) => update('message', e.target.value)}
                    />
                    <p className="text-[10px] text-gray-400">Supports emojis and basic formatting.</p>
                </div>

                {/* 2. MEDIA CONFIGURATION */}
                {isMediaType && (
                    <div className="space-y-3 p-4 bg-amber-50 rounded-xl border border-amber-100">
                        <label className="text-xs font-bold text-amber-800 uppercase flex items-center gap-2">
                            <ImageIcon size={12} /> {localData.label} Source
                        </label>
                        
                        {localData.mediaUrl ? (
                             <div className="relative group rounded-lg overflow-hidden border border-amber-200 bg-white aspect-video">
                                {localData.label === 'Video' ? <video src={localData.mediaUrl} className="w-full h-full object-cover" /> : <img src={localData.mediaUrl} className="w-full h-full object-cover" alt="Selected" />}
                                <button 
                                    onClick={() => update('mediaUrl', '')}
                                    className="absolute top-2 right-2 bg-red-600 text-white p-1.5 rounded-full opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                                >
                                    <Trash2 size={12} />
                                </button>
                             </div>
                        ) : (
                            <div className="text-center p-4 border-2 border-dashed border-amber-200 rounded-lg bg-white/50">
                                <p className="text-xs text-amber-600 mb-2">No asset selected</p>
                            </div>
                        )}

                        <div className="flex gap-2">
                            <button 
                                onClick={() => setShowMediaPicker(true)}
                                className="flex-1 py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-2 shadow-sm"
                            >
                                <Cloud size={14} /> Library
                            </button>
                        </div>
                        
                        <div className="relative">
                            <input 
                                type="text" 
                                className="w-full pl-7 pr-3 py-2 text-xs border border-amber-200 rounded-lg focus:outline-none focus:border-amber-500"
                                placeholder="Or paste URL..."
                                value={localData.mediaUrl || ''}
                                onChange={(e) => update('mediaUrl', e.target.value)}
                            />
                            <div className="absolute left-2.5 top-2.5 text-amber-400"><Search size={12} /></div>
                        </div>
                    </div>
                )}

                {/* 3. OPTIONS / BUTTONS */}
                {isOptionType && (
                    <div className="space-y-3">
                        <label className="text-xs font-bold text-gray-500 uppercase flex justify-between items-center">
                            <span>Interactive Buttons</span>
                            <span className="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-[10px]">{localData.options?.length || 0} / 10</span>
                        </label>
                        
                        <div className="space-y-2">
                            {(localData.options || []).map((opt: string, idx: number) => (
                                <div key={idx} className="flex gap-2 group animate-in slide-in-from-left-2 fade-in duration-200">
                                    <div className="flex-1 flex items-center bg-white border border-gray-200 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-purple-100 focus-within:border-purple-300 transition-all">
                                        <span className="w-8 h-full bg-gray-50 flex items-center justify-center text-[10px] font-mono text-gray-400 border-r border-gray-100">{idx + 1}</span>
                                        <input 
                                            value={opt}
                                            onChange={(e) => {
                                                const newOpts = [...localData.options];
                                                newOpts[idx] = e.target.value;
                                                update('options', newOpts);
                                            }}
                                            className="flex-1 px-3 py-2 text-xs outline-none text-gray-700 font-medium"
                                            placeholder="Label (e.g. Yes)"
                                        />
                                    </div>
                                    <button 
                                        onClick={() => {
                                            const newOpts = localData.options.filter((_: any, i: number) => i !== idx);
                                            update('options', newOpts);
                                        }}
                                        className="p-2 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                                    >
                                        <X size={16} />
                                    </button>
                                </div>
                            ))}
                        </div>

                        <button 
                            onClick={() => update('options', [...(localData.options || []), `Option ${(localData.options?.length || 0) + 1}`])}
                            className="w-full py-2 border border-dashed border-gray-300 rounded-lg text-xs font-bold text-gray-500 hover:text-purple-600 hover:border-purple-300 hover:bg-purple-50 transition-all flex items-center justify-center gap-2"
                        >
                            <Plus size={14} /> Add Button Option
                        </button>
                    </div>
                )}

                {/* 4. VARIABLE STORAGE */}
                {isInputType && (
                    <div className="p-4 bg-purple-50 rounded-xl border border-purple-100 space-y-2">
                        <label className="text-xs font-bold text-purple-800 uppercase flex items-center gap-2">
                            <Hash size={12} /> Save Response To
                        </label>
                        <select 
                            value={localData.saveToField || ''}
                            onChange={(e) => update('saveToField', e.target.value)}
                            className="w-full bg-white border border-purple-200 text-purple-900 text-xs font-medium rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-purple-500 outline-none cursor-pointer"
                        >
                            <option value="">-- Don't Save --</option>
                            <option value="name">user_name</option>
                            <option value="vehicleRegistration">vehicle_number</option>
                            <option value="availability">availability_status</option>
                            <option value="document">document_url</option>
                            <option value="email">email_address</option>
                        </select>
                        <p className="text-[10px] text-purple-600/80">Captured value will update the driver profile.</p>
                    </div>
                )}

                {/* 5. TEMPLATE OVERRIDE (MODIFIED to Select Only) */}
                <div className="pt-4 border-t border-gray-100">
                    <div className="flex items-center justify-between mb-2">
                         <label className="text-xs font-bold text-gray-500 uppercase flex items-center gap-1">
                             <FileCode size={12} /> Meta Template ID
                         </label>
                    </div>
                    <select 
                         value={localData.templateName || ''}
                         onChange={(e) => update('templateName', e.target.value)}
                         className="w-full bg-gray-50 border border-gray-200 text-gray-600 text-xs font-mono rounded-lg px-3 py-2 focus:ring-2 focus:ring-gray-300 outline-none"
                    >
                        <option value="">-- Select System Template --</option>
                        {SYSTEM_TEMPLATES.map(t => (
                            <option key={t} value={t}>{t}</option>
                        ))}
                    </select>
                    <p className="text-[10px] text-gray-400 mt-1">
                        Use only pre-approved Meta System Templates.
                    </p>
                </div>

            </div>
            
            <div className="p-4 border-t border-gray-200 bg-gray-50 text-center text-[10px] text-gray-400">
                Changes autosave to canvas
            </div>

            {/* Media Picker Modal */}
            {showMediaPicker && (
                <MediaPicker 
                    type={localData.label === 'Video' ? 'video' : 'image'} 
                    onClose={() => setShowMediaPicker(false)} 
                    onSelect={(url) => update('mediaUrl', url)} 
                />
            )}
        </div>
    );
};

const nodeTypes = { custom: NodePreviewCard };

const DraggableSidebarItem = ({ type, inputType, label, icon }: any) => {
    const onDragStart = (event: React.DragEvent) => {
      event.dataTransfer.setData('application/reactflow/type', type);
      // Ensure inputType is defined or defaults to 'text'
      event.dataTransfer.setData('application/reactflow/inputType', inputType || 'text');
      event.dataTransfer.setData('application/reactflow/label', label);
      event.dataTransfer.effectAllowed = 'move';
    };
  
    return (
      <div 
        className="bg-white border border-gray-200 rounded-xl px-4 py-3 cursor-grab hover:shadow-md hover:border-blue-400 hover:bg-blue-50/30 transition-all flex items-center gap-3 group select-none active:scale-95" 
        onDragStart={onDragStart} 
        draggable
      >
        <div className="p-2 bg-gray-100 rounded-lg text-gray-500 group-hover:bg-blue-100 group-hover:text-blue-600 transition-colors">
            {icon}
        </div>
        <span className="text-sm font-medium text-gray-700 group-hover:text-blue-900">{label}</span>
        <GripVertical size={14} className="ml-auto text-gray-300" />
      </div>
    );
};

// --- MAIN WRAPPER ---
export const BotBuilder = ({ isLiveMode }: { isLiveMode: boolean }) => {
    return (
        <ReactFlowProvider>
            <FlowEditor isLiveMode={isLiveMode} />
        </ReactFlowProvider>
    );
};

const FlowEditor = ({ isLiveMode }: { isLiveMode: boolean }) => {
    const { 
        nodes, edges, onNodesChange, onEdgesChange, onConnect, 
        setNodes, setEdges, addNode, updateNodeData 
    } = useFlowStore();
    
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    
    // Initial Load & Sanitization
    useEffect(() => {
        const load = async () => {
            const settings = isLiveMode ? await liveApiService.getBotSettings() : mockBackend.getBotSettings();
            if (settings.flowData && settings.flowData.nodes.length > 0) {
                // SANITIZATION: Remove any legacy 'icon' properties from JSON to prevent React Crash
                const cleanNodes = settings.flowData.nodes.map((n: any) => {
                    const { icon, ...cleanData } = n.data || {};
                    // Ensure inputType isn't the string "undefined"
                    if (cleanData.inputType === "undefined") cleanData.inputType = "text";
                    return { ...n, data: cleanData };
                });
                
                setNodes(cleanNodes);
                setEdges(settings.flowData.edges);
            }
        };
        load();
    }, [isLiveMode, setNodes, setEdges]);

    // Drag & Drop
    const onDragOver = useCallback((event: React.DragEvent) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }, []);
    const onDrop = useCallback((event: React.DragEvent) => {
        event.preventDefault();
        const type = event.dataTransfer.getData('application/reactflow/type');
        let inputType = event.dataTransfer.getData('application/reactflow/inputType');
        const label = event.dataTransfer.getData('application/reactflow/label');
        if (!type) return;

        // Fix potential string "undefined"
        if (!inputType || inputType === "undefined") inputType = "text";

        const position = { x: event.clientX - 300, y: event.clientY }; // Adjust for sidebar offset approximation

        // NOTE: We do NOT store 'icon' in data anymore to prevent JSON serialization crashes
        const newNode: Node = {
            id: `node_${Date.now()}`,
            type: 'custom',
            position,
            data: { 
                label, 
                message: '', 
                inputType,
                options: inputType === 'option' ? ['Yes', 'No'] : undefined,
                mediaUrl: ''
            },
        };
        addNode(newNode);
        setSelectedNodeId(newNode.id); // Auto-select new node
    }, [addNode]);

    const handleSave = async () => {
        setIsSaving(true);
        const compiledSteps: BotStep[] = [];
        
        // Find Entry Point from the edge connected to 'start' source
        const startEdge = edges.find(e => e.source === 'start');
        let entryPointId = startEdge?.target;
        
        // Compile logical steps for backend
        nodes.forEach(node => {
            const data = node.data as any; // Cast to any to bypass type issues with Record<string, unknown>

            if (data.type === 'start') return;
            const outgoingEdges = edges.filter(e => e.source === node.id);
            let nextStepId = 'END';
            if (outgoingEdges.length > 0) nextStepId = outgoingEdges[0].target; // Default next
            
            // Clean data before saving (double check)
            const { icon, ...cleanData } = data;

            // Sanitize template name
            let templateName = cleanData.templateName;
            if (templateName && (templateName.includes(':') || templateName.includes(' '))) {
                templateName = undefined;
            }

            // EXPLICIT MEDIA TYPE INFERENCE FOR ROBUST BACKEND HANDLING
            let inferredMediaType: 'image' | 'video' | 'document' | undefined = undefined;
            if (cleanData.label === 'Video') inferredMediaType = 'video';
            else if (cleanData.label === 'Image') inferredMediaType = 'image';
            else if (cleanData.label === 'File') inferredMediaType = 'document';

            compiledSteps.push({
                id: node.id,
                title: cleanData.label,
                message: cleanData.message,
                inputType: cleanData.inputType,
                options: cleanData.options,
                saveToField: cleanData.saveToField,
                nextStepId, 
                mediaUrl: cleanData.mediaUrl,
                templateName: templateName,
                mediaType: inferredMediaType // NEW: Store explicit type
            });
        });

        // Fallback: If no explicit connection from Start, assume the first added node is the entry (backward compatibility)
        if (!entryPointId && compiledSteps.length > 0) {
            entryPointId = compiledSteps[0].id;
        }

        // Clean nodes for storage (remove any runtime props)
        const storageNodes = nodes.map(n => {
            const { icon, ...cleanData } = n.data as any;
            return { ...n, data: cleanData };
        });

        const newSettings: BotSettings = {
            ...(isLiveMode ? await liveApiService.getBotSettings() : mockBackend.getBotSettings()),
            steps: compiledSteps,
            entryPointId,
            flowData: { nodes: storageNodes, edges }
        };

        try {
            if (isLiveMode) await liveApiService.saveBotSettings(newSettings);
            else mockBackend.updateBotSettings(newSettings);
        } catch (e) { alert("Save failed"); }
        setTimeout(() => setIsSaving(false), 500);
    };

    const selectedNode = useMemo(() => nodes.find(n => n.id === selectedNodeId), [nodes, selectedNodeId]);

    return (
        <div className="flex h-full bg-slate-50 font-sans relative overflow-hidden">
            {/* LEFT TOOLBAR */}
            <div className="w-64 bg-white border-r border-gray-200 flex flex-col z-10 shadow-lg">
                <div className="p-5 border-b border-gray-100">
                    <h2 className="font-bold text-gray-900 flex items-center gap-2 text-lg">
                        <Zap className="text-yellow-500 fill-yellow-500" size={20} /> Bot Studio
                    </h2>
                    <p className="text-xs text-gray-500 mt-1">Drag blocks to build flow</p>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-6">
                    <div>
                        <h4 className="text-[10px] font-bold text-gray-400 uppercase mb-3 tracking-wider">Messages</h4>
                        <div className="space-y-2">
                            <DraggableSidebarItem type="text" label="Text Message" icon={<MessageSquare size={16} />} />
                            <DraggableSidebarItem type="image" label="Image" icon={<ImageIcon size={16} />} />
                            <DraggableSidebarItem type="video" label="Video" icon={<Video size={16} />} />
                        </div>
                    </div>
                    <div>
                        <h4 className="text-[10px] font-bold text-gray-400 uppercase mb-3 tracking-wider">Interaction</h4>
                        <div className="space-y-2">
                            <DraggableSidebarItem type="option" inputType="option" label="Quick Reply / List" icon={<List size={16} />} />
                            <DraggableSidebarItem type="input" inputType="text" label="Collect Text" icon={<Type size={16} />} />
                        </div>
                    </div>
                </div>
            </div>

            {/* CANVAS AREA */}
            <div className="flex-1 relative h-full flex flex-col">
                <div className="absolute top-4 right-4 z-20 flex gap-2">
                    <button onClick={handleSave} disabled={isSaving} className="bg-black text-white px-5 py-2.5 rounded-full text-sm font-bold shadow-lg hover:bg-gray-800 transition-all flex items-center gap-2">
                        {isSaving ? <span className="animate-spin"><Zap size={16} /></span> : <CheckCircle size={16} />}
                        {isSaving ? 'Publishing...' : 'Publish Flow'}
                    </button>
                </div>

                <div className="flex-1 h-full" onDragOver={onDragOver} onDrop={onDrop}>
                    <ReactFlow
                        nodes={nodes}
                        edges={edges}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onConnect={onConnect}
                        nodeTypes={{ custom: NodePreviewCard }}
                        onNodeClick={(_, node) => setSelectedNodeId(node.id)}
                        onPaneClick={() => setSelectedNodeId(null)}
                        defaultViewport={{ x: 0, y: 0, zoom: 0.8 }}
                        minZoom={0.2} maxZoom={1.5}
                        fitView
                    >
                        <Background color="#cbd5e1" gap={20} size={1} variant={BackgroundVariant.Dots} />
                        <Controls className="bg-white border border-gray-200 shadow-xl rounded-lg p-1" />
                        <MiniMap className="border border-gray-200 rounded-lg shadow-xl" nodeColor="#3b82f6" maskColor="rgba(240, 242, 245, 0.7)" />
                    </ReactFlow>
                </div>
            </div>

            {/* RIGHT PROPERTY INSPECTOR */}
            {selectedNode && (
                <PropertyInspector 
                    selectedNode={selectedNode} 
                    onChange={updateNodeData} 
                />
            )}
        </div>
    );
};
