
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { 
  ReactFlow, 
  MiniMap, 
  Controls, 
  Background, 
  BackgroundVariant,
  Handle, 
  Position,
  ReactFlowProvider,
  useReactFlow,
  Panel,
  useNodesState,
  useEdgesState,
  addEdge
} from '@xyflow/react';
import type { Node, Connection, Edge } from '@xyflow/react';
import { BotSettings, BotStep } from '../types';
import { mockBackend } from '../services/mockBackend';
import { liveApiService } from '../services/liveApiService';
import { useFlowStore } from '../services/flowStore'; 
import { 
  MessageSquare, Image as ImageIcon, Video, List, Type, Hash, 
  LayoutGrid, X, Trash2, Zap, CheckCircle, Flag, ShieldAlert, 
  GripVertical, MousePointerClick, FileCode, Brush, Eye, 
  ChevronRight, Folder, ArrowLeft, Search, Cloud, Plus, Link, HelpCircle, Split, GitBranch, ArrowRight, AlertTriangle, File, Loader2, RefreshCw
} from 'lucide-react';

// --- STYLES ---
const HANDLE_STYLE_COMMON = { width: 10, height: 10, border: '2px solid white', zIndex: 50 };
const INPUT_HANDLE_STYLE = { ...HANDLE_STYLE_COMMON, background: '#94a3b8', left: -5 };
const OUTPUT_HANDLE_STYLE = { ...HANDLE_STYLE_COMMON, background: '#3b82f6', right: -5 };
const OPTION_HANDLE_STYLE = { 
    ...HANDLE_STYLE_COMMON,
    width: 14, 
    height: 14, 
    background: '#8b5cf6', // Violet
    right: -7,
    borderRadius: '50%',
    boxShadow: '0 0 0 2px rgba(139, 92, 246, 0.2)'
};

const getIconForLabel = (label: string) => {
    switch(label) {
        case 'Image': return <ImageIcon size={14} />;
        case 'Video': return <Video size={14} />;
        case 'Question':
        case 'Quick Reply': 
        case 'List': return <GitBranch size={14} />;
        case 'Collect Text': return <Type size={14} />;
        case 'Link': return <Link size={14} />;
        default: return <MessageSquare size={14} />;
    }
};

// --- MEDIA SELECTOR MODAL ---
const MediaSelectorModal = ({ isOpen, onClose, onSelect, allowedType }: any) => {
    const [files, setFiles] = useState<any[]>([]);
    const [folders, setFolders] = useState<any[]>([]);
    const [currentPath, setCurrentPath] = useState('/');
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (isOpen) {
            loadMedia(currentPath);
        } else {
            setCurrentPath('/'); // Reset to root on close
        }
    }, [isOpen, currentPath]);

    const loadMedia = (path: string) => {
        setLoading(true);
        liveApiService.getMediaLibrary(path)
            .then(data => {
                setFolders(data.folders);
                const filtered = data.files.filter((f: any) => 
                    allowedType === 'Video' ? f.type === 'video' : f.type === 'image'
                );
                setFiles(filtered);
            })
            .catch(console.error)
            .finally(() => setLoading(false));
    };

    const handleFolderClick = (folderName: string) => {
        const newPath = currentPath === '/' ? `/${folderName}` : `${currentPath}/${folderName}`;
        setCurrentPath(newPath);
    };

    const handleBackClick = () => {
         if (currentPath === '/') return;
         const parts = currentPath.split('/').filter(Boolean);
         parts.pop();
         const newPath = parts.length === 0 ? '/' : `/${parts.join('/')}`;
         setCurrentPath(newPath);
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4 backdrop-blur-sm">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl h-[80vh] flex flex-col animate-in fade-in zoom-in-95">
                <div className="p-4 border-b border-gray-100 flex justify-between items-center bg-gray-50 rounded-t-xl">
                    <h3 className="font-bold text-gray-900 flex items-center gap-2">
                        <Cloud size={18} className="text-blue-600" /> 
                        Select {allowedType} from S3
                    </h3>
                    <button onClick={onClose}><X size={20} className="text-gray-400" /></button>
                </div>
                
                <div className="bg-white px-4 py-2 border-b border-gray-100 text-xs text-gray-500 flex items-center gap-2">
                    <span className="font-bold text-gray-700">Path:</span> 
                    <span className="font-mono bg-gray-100 px-1 rounded">{currentPath}</span>
                </div>

                <div className="flex-1 overflow-y-auto p-4 bg-slate-50">
                    {loading ? (
                        <div className="flex justify-center p-10"><span className="animate-spin mr-2">⏳</span> Loading Library...</div>
                    ) : (
                        <>
                            {currentPath !== '/' && (
                                <button 
                                    onClick={handleBackClick} 
                                    className="flex items-center gap-2 text-sm text-gray-600 mb-4 hover:text-blue-600 font-medium px-2 py-1 rounded hover:bg-white"
                                >
                                    <ArrowLeft size={16} /> Back to parent
                                </button>
                            )}

                            {/* Folders */}
                            {folders.length > 0 && (
                                <div className="mb-6">
                                    <h4 className="text-[10px] font-bold text-gray-400 uppercase mb-2 tracking-wider">Folders</h4>
                                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                                        {folders.map(folder => (
                                            <div 
                                                key={folder.id} 
                                                onClick={() => handleFolderClick(folder.name)}
                                                className="bg-white p-3 rounded-lg border border-gray-200 cursor-pointer hover:border-blue-400 hover:shadow-sm flex flex-col items-center gap-2 transition-all"
                                            >
                                                <Folder size={28} className="text-yellow-400 fill-yellow-100" />
                                                <span className="text-xs font-medium text-gray-700 truncate w-full text-center">{folder.name}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Files */}
                            <div>
                                <h4 className="text-[10px] font-bold text-gray-400 uppercase mb-2 tracking-wider">Files</h4>
                                {files.length === 0 ? (
                                    <div className="text-center py-8 text-gray-400 text-sm italic border-2 border-dashed border-gray-200 rounded-lg">
                                        No matching {allowedType.toLowerCase()}s found in this folder.
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                                        {files.map((file) => (
                                            <div 
                                                key={file.id}
                                                onClick={() => onSelect(file.url)}
                                                className="bg-white rounded-lg border border-gray-200 p-2 cursor-pointer hover:border-blue-500 hover:ring-2 hover:ring-blue-200 transition-all group"
                                            >
                                                <div className="aspect-video bg-gray-100 rounded overflow-hidden mb-2 relative flex items-center justify-center">
                                                    {file.type === 'image' ? (
                                                        <img src={file.url} className="w-full h-full object-cover" alt="prev" />
                                                    ) : (
                                                        <Video size={24} className="text-gray-400" />
                                                    )}
                                                </div>
                                                <div className="text-xs font-medium text-gray-700 truncate px-1" title={file.filename}>{file.filename}</div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

// --- NODE PREVIEW CARD ---
const NodePreviewCard = ({ data, id, selected }: any) => {
  const isMediaType = ['Image', 'Video'].includes(data.label);
  const isOptionType = ['Quick Reply', 'List', 'Question'].includes(data.label) || data.inputType === 'option';
  const isLinkType = data.label === 'Link';
  
  // Validation Checks (Strict Anti-Placeholder)
  const hasPlaceholder = data.message && /replace\s+this|enter\s+your|type\s+your|sample\s+message/i.test(data.message);
  const isEmptyOptions = isOptionType && (!data.options || data.options.length === 0);
  const isDanger = hasPlaceholder || isEmptyOptions;

  let borderColor = 'border-gray-200';
  let accentColor = 'bg-gray-50';
  let iconColor = 'text-gray-500';

  if (isMediaType) { borderColor = 'border-amber-200'; accentColor = 'bg-amber-50'; iconColor = 'text-amber-600'; }
  else if (isOptionType) { borderColor = 'border-violet-300'; accentColor = 'bg-violet-50'; iconColor = 'text-violet-600'; }
  else if (isLinkType) { borderColor = 'border-sky-200'; accentColor = 'bg-sky-50'; iconColor = 'text-sky-600'; }
  else if (data.label === 'Text Message') { borderColor = 'border-blue-200'; accentColor = 'bg-blue-50'; iconColor = 'text-blue-600'; }

  if (selected) borderColor = 'border-blue-500 ring-2 ring-blue-100 shadow-md';
  if (isDanger) borderColor = 'border-red-500 ring-2 ring-red-100 bg-red-50/20';

  if (data.type === 'start') {
      return (
        <div className={`w-[240px] shadow-md rounded-xl bg-white border-2 transition-all ${selected ? 'border-green-500 ring-4 ring-green-50' : 'border-gray-100'}`}>
            <div className="bg-green-50 px-4 py-3 rounded-t-lg border-b border-green-100 flex items-center gap-2">
                <Flag size={16} className="text-green-600" />
                <span className="text-xs font-bold text-green-800 uppercase">Entry Point</span>
            </div>
            <div className="p-4 text-center text-xs text-gray-500">Flow starts here</div>
            <Handle type="source" position={Position.Right} style={OUTPUT_HANDLE_STYLE} />
        </div>
      );
  }

  return (
    <div className={`w-[340px] bg-white rounded-xl shadow-lg border-2 transition-all group ${borderColor}`}>
        <Handle type="target" position={Position.Left} style={INPUT_HANDLE_STYLE} />
        
        {/* Header */}
        <div className={`px-4 py-3 border-b flex items-center justify-between rounded-t-lg ${accentColor} ${borderColor}`}>
            <div className="flex items-center gap-2">
                <div className={`p-1.5 rounded-md ${iconColor} bg-white shadow-sm border border-black/5`}>{getIconForLabel(data.label)}</div>
                <span className={`text-xs font-bold uppercase tracking-wide ${iconColor}`}>{data.label}</span>
            </div>
            {isDanger && (
                <div className="flex items-center gap-1 text-red-600" title="Placeholder text detected! This will be blocked.">
                    <span className="text-[10px] font-bold">INVALID</span>
                    <ShieldAlert size={16} className="animate-pulse" />
                </div>
            )}
        </div>

        {/* Body */}
        <div className="p-4">
            
            {/* Link Label Preview */}
            {isLinkType && data.linkLabel && (
                 <div className="mb-2 text-xs font-bold text-gray-900 bg-sky-50 px-2 py-1 rounded border border-sky-100">
                    {data.linkLabel}
                 </div>
            )}

            {/* Message Text (or URL for Link) */}
            {data.label !== 'Image' && data.label !== 'Video' && (
                <div className="bg-gray-50 p-3 rounded-lg border border-gray-100 mb-3 relative overflow-hidden">
                    <p className={`text-xs leading-relaxed font-medium truncate ${hasPlaceholder ? 'text-red-600 font-bold' : 'text-gray-700'}`}>
                        {data.message || <span className="italic text-gray-300">No content...</span>}
                    </p>
                    {hasPlaceholder && <div className="text-[9px] text-red-500 mt-1">⚠️ Change default text</div>}
                </div>
            )}

            {/* Media Preview */}
            {isMediaType && (
                <div className="mb-3 rounded-lg bg-gray-100 border border-gray-200 aspect-video overflow-hidden flex items-center justify-center relative group/media">
                    {data.mediaUrl ? (
                        data.label === 'Video' ? <video src={data.mediaUrl} className="w-full h-full object-cover" /> : <img src={data.mediaUrl} className="w-full h-full object-cover" alt="preview" />
                    ) : (
                        <div className="text-center p-4">
                             <Cloud size={24} className="mx-auto text-gray-300 mb-1" />
                             <span className="text-[10px] text-gray-400 font-medium">Select {data.label} from S3</span>
                        </div>
                    )}
                </div>
            )}

            {/* Options Routing UI */}
            {isOptionType && (
                <div className="mt-4 space-y-3">
                    <div className="flex items-center justify-between mb-2">
                        <div className="text-[10px] font-bold text-violet-500 uppercase tracking-wider flex items-center gap-1">
                            <GitBranch size={12} /> Routes
                        </div>
                    </div>
                    {data.options?.map((opt: string, i: number) => (
                        <div key={i} className="relative flex items-center justify-between bg-white border-2 border-gray-100 hover:border-violet-300 px-3 py-3 rounded-lg shadow-sm transition-all group/opt">
                            <span className="text-xs font-bold text-gray-700 truncate max-w-[200px]" title={opt}>{opt || '(Empty)'}</span>
                            <div className="h-[2px] bg-gray-100 flex-1 mx-3 group-hover/opt:bg-violet-100 transition-colors"></div>
                            <div className="relative flex items-center">
                                <span className="text-[9px] text-gray-400 mr-2 uppercase font-mono group-hover/opt:text-violet-600 font-bold tracking-tight">Next</span>
                                <ArrowRight size={12} className="text-gray-300 mr-1 group-hover/opt:text-violet-400" />
                                <Handle type="source" position={Position.Right} id={`option-${i}`} style={OPTION_HANDLE_STYLE} />
                            </div>
                        </div>
                    ))}
                </div>
            )}
            
            {/* Variable Save Indicator */}
            {data.saveToField && (
                <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between text-[10px]">
                    <span className="text-gray-400 font-medium">Saves to variable</span>
                    <span className="text-purple-700 font-mono bg-purple-50 px-2 py-0.5 rounded border border-purple-100 flex items-center gap-1">
                        <Hash size={8} /> {data.saveToField}
                    </span>
                </div>
            )}
        </div>

        {/* Fallback Main Output (Only if NOT option type) */}
        {!isOptionType && (
            <div className="absolute -right-3 top-1/2 transform -translate-y-1/2">
                <Handle type="source" position={Position.Right} id="main" style={OUTPUT_HANDLE_STYLE} />
            </div>
        )}
    </div>
  );
};

// --- PROPERTY INSPECTOR ---
const PropertyInspector = ({ selectedNode, onChange }: { selectedNode: Node, onChange: (id: string, data: any) => void }) => {
    const [localData, setLocalData] = useState<any>(selectedNode.data);
    const [showMediaPicker, setShowMediaPicker] = useState(false);

    useEffect(() => { setLocalData(selectedNode.data); }, [selectedNode]);

    const update = (field: string, value: any) => {
        const newData = { ...localData, [field]: value };
        if (newData.icon) delete newData.icon; 
        setLocalData(newData);
        onChange(selectedNode.id, newData);
    };

    if (localData.type === 'start') return <div className="p-6 text-center text-gray-400 text-sm">Start Node has no properties.</div>;

    const isMediaType = ['Image', 'Video'].includes(localData.label);
    const isOptionType = ['Quick Reply', 'List', 'Question'].includes(localData.label) || localData.inputType === 'option';
    const isLinkType = localData.label === 'Link';
    const isInputType = ['Text', 'Number'].includes(localData.label) || localData.inputType === 'text';

    return (
        <div className="w-80 bg-white border-l border-gray-200 flex flex-col h-full shadow-xl z-20">
            <div className="px-5 py-4 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
                <h3 className="font-bold text-gray-800">{localData.label} Properties</h3>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-6">
                
                {/* Link Label Input */}
                {isLinkType && (
                     <div className="space-y-2">
                        <label className="text-xs font-bold text-sky-600 uppercase">Link Label</label>
                        <input 
                            className="w-full p-2 bg-white border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-sky-500 outline-none"
                            placeholder="e.g. Visit Our Website"
                            value={localData.linkLabel || ''}
                            onChange={(e) => update('linkLabel', e.target.value)}
                        />
                        <p className="text-[10px] text-gray-400">Displayed above the link URL.</p>
                     </div>
                )}

                {/* Message / URL Input */}
                {!isMediaType && (
                    <div className="space-y-2">
                        <label className="text-xs font-bold text-gray-500 uppercase">
                            {isLinkType ? 'Link URL' : 'Message Text'}
                        </label>
                        <textarea 
                            className="w-full h-32 p-3 bg-white border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none transition-shadow shadow-sm"
                            placeholder={isLinkType ? "https://..." : "Type what the bot should say..."}
                            value={localData.message || ''}
                            onChange={(e) => update('message', e.target.value)}
                        />
                        <p className="text-[10px] text-gray-400 italic">Do not leave "Replace this..." text.</p>
                    </div>
                )}

                {/* Media Selector */}
                {isMediaType && (
                    <div className="space-y-4">
                        <label className="text-xs font-bold text-amber-600 uppercase">Selected Asset</label>
                        
                        <div className="bg-gray-100 rounded-lg aspect-video flex items-center justify-center border border-gray-200 overflow-hidden relative group">
                            {localData.mediaUrl ? (
                                localData.label === 'Video' ? <video src={localData.mediaUrl} className="w-full h-full object-cover" /> : <img src={localData.mediaUrl} className="w-full h-full object-cover" alt="prev" />
                            ) : (
                                <div className="text-center p-2">
                                    <Cloud size={24} className="mx-auto text-gray-400 mb-1" />
                                    <span className="text-[10px] text-gray-500">No Asset</span>
                                </div>
                            )}
                            {localData.mediaUrl && (
                                <button 
                                    onClick={() => update('mediaUrl', '')}
                                    className="absolute top-2 right-2 bg-red-500 text-white p-1 rounded shadow hover:bg-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                                >
                                    <Trash2 size={12} />
                                </button>
                            )}
                        </div>

                        <button 
                            onClick={() => setShowMediaPicker(true)}
                            className="w-full py-2.5 bg-amber-100 text-amber-700 font-bold rounded-lg text-xs hover:bg-amber-200 transition-colors flex items-center justify-center gap-2 border border-amber-200"
                        >
                            <Cloud size={14} /> Select from S3 Library
                        </button>
                    </div>
                )}

                {/* Options Manager */}
                {isOptionType && (
                    <div className="space-y-3">
                        <label className="text-xs font-bold text-gray-500 uppercase flex justify-between items-center">
                            <span>Answer Options</span>
                        </label>
                        <div className="space-y-2">
                            {(localData.options || []).map((opt: string, idx: number) => (
                                <div key={idx} className="flex gap-2 group">
                                    <div className="flex-1 flex items-center bg-white border border-gray-200 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-violet-100 focus-within:border-violet-300">
                                        <span className="w-8 h-full bg-gray-50 flex items-center justify-center text-[10px] font-mono text-gray-400 border-r border-gray-100">{idx + 1}</span>
                                        <input 
                                            value={opt}
                                            onChange={(e) => {
                                                const newOpts = [...localData.options];
                                                newOpts[idx] = e.target.value;
                                                update('options', newOpts);
                                            }}
                                            className="flex-1 px-3 py-2 text-xs outline-none text-gray-700 font-medium"
                                            placeholder="Option Label"
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
                            className="w-full py-2 border border-dashed border-gray-300 rounded-lg text-xs font-bold text-gray-500 hover:text-violet-600 hover:border-violet-300 hover:bg-violet-50 transition-all flex items-center justify-center gap-2"
                        >
                            <Plus size={14} /> Add Option
                        </button>
                    </div>
                )}

                {/* Variable Saving */}
                {isInputType && (
                    <div className="space-y-2 pt-4 border-t border-gray-100">
                        <label className="text-xs font-bold text-purple-800 uppercase flex items-center gap-2">
                            <Hash size={12} /> Save User Reply To
                        </label>
                        <select 
                            value={localData.saveToField || ''}
                            onChange={(e) => update('saveToField', e.target.value)}
                            className="w-full bg-white border border-gray-200 text-gray-700 text-xs rounded-lg px-3 py-2 focus:ring-2 focus:ring-purple-500 outline-none"
                        >
                            <option value="">-- Do Not Save --</option>
                            <option value="name">user_name</option>
                            <option value="vehicleRegistration">vehicle_number</option>
                            <option value="availability">availability_status</option>
                            <option value="document">document_url</option>
                            <option value="email">email_address</option>
                        </select>
                    </div>
                )}
            </div>
            
            <MediaSelectorModal 
                isOpen={showMediaPicker} 
                onClose={() => setShowMediaPicker(false)}
                onSelect={(url: string) => { update('mediaUrl', url); setShowMediaPicker(false); }}
                allowedType={localData.label}
            />
        </div>
    );
};

// --- DRAGGABLE SIDEBAR ---
const DraggableSidebarItem = ({ type, inputType, label, icon }: any) => {
    const onDragStart = (event: React.DragEvent) => {
      event.dataTransfer.setData('application/reactflow/type', type);
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

// --- MAIN COMPONENT ---
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
        setNodes, setEdges, addNode, updateNodeData, resetFlow
    } = useFlowStore();
    
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [lastLoadedTime, setLastLoadedTime] = useState<number>(0);

    const loadData = useCallback(async () => {
        setIsLoading(true);
        setLoadError(null);
        try {
            // Reset flow to clean state before loading to prevent ghosts
            // But we keep Start Node as default fallback inside the store
            const settings = isLiveMode ? await liveApiService.getBotSettings() : mockBackend.getBotSettings();
            
            if (settings.flowData && settings.flowData.nodes.length > 0) {
                const cleanNodes = settings.flowData.nodes.map((n: any) => {
                    const { icon, ...cleanData } = n.data || {};
                    if (cleanData.inputType === "undefined") cleanData.inputType = "text";
                    return { ...n, data: cleanData };
                });
                setNodes(cleanNodes);
                setEdges(settings.flowData.edges);
            } else {
                // If DB is empty, use default start node from store (already there)
                // or ensure Start Node exists if store was cleared
                resetFlow(); 
            }
            setLastLoadedTime(Date.now());
        } catch (e: any) {
            console.error("BotBuilder Load Error:", e);
            setLoadError(e.message || "Failed to load bot flow");
        } finally {
            setIsLoading(false);
        }
    }, [isLiveMode, setNodes, setEdges, resetFlow]);
    
    // Load on Mount or Mode Change
    useEffect(() => {
        loadData();
    }, [loadData]);

    // Drag Drop
    const onDragOver = useCallback((event: React.DragEvent) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }, []);
    const onDrop = useCallback((event: React.DragEvent) => {
        event.preventDefault();
        if (isLoading || loadError) return; // Prevent editing while loading/error

        const type = event.dataTransfer.getData('application/reactflow/type');
        let inputType = event.dataTransfer.getData('application/reactflow/inputType');
        const label = event.dataTransfer.getData('application/reactflow/label');
        if (!type) return;
        if (!inputType || inputType === "undefined") inputType = "text";

        const position = { x: event.clientX - 300, y: event.clientY };
        const newNode: Node = {
            id: `node_${Date.now()}`,
            type: 'custom',
            position,
            data: { 
                label, 
                message: '', 
                inputType,
                options: inputType === 'option' ? ['Yes', 'No'] : undefined,
                mediaUrl: '',
                linkLabel: ''
            },
        };
        addNode(newNode);
        setSelectedNodeId(newNode.id);
    }, [addNode, isLoading, loadError]);

    // --- COMPILER LOGIC (Fixed for Production) ---
    const handleSave = async () => {
        if (isLoading || loadError) return; // Prevent overwriting if not loaded correctly

        setIsSaving(true);
        const compiledSteps: BotStep[] = [];
        
        // 1. Identify Entry Point
        const startEdge = edges.find(e => e.source === 'start');
        let entryPointId = startEdge?.target;
        
        // 2. Iterate Nodes to Build Steps
        nodes.forEach(node => {
            const data = node.data as any;
            if (data.type === 'start') return;
            
            const outgoingEdges = edges.filter(e => e.source === node.id);
            let nextStepId: string | undefined = 'END'; 
            let routes: Record<string, string> = {};

            // A. Check for DEFAULT connection (Main Handle)
            const mainEdge = outgoingEdges.find(e => e.sourceHandle === 'main' || !e.sourceHandle);
            if (mainEdge) nextStepId = mainEdge.target;

            // B. Check for SPECIFIC OPTION connections
            if (data.options && data.options.length > 0) {
                data.options.forEach((optText: string, idx: number) => {
                     const handleId = `option-${idx}`;
                     const edge = outgoingEdges.find(e => e.sourceHandle === handleId);
                     if (edge && optText && optText.trim()) {
                         routes[optText.trim()] = edge.target;
                     }
                });
            }
            
            // C. Sanitize Data
            const { icon, ...cleanData } = data;
            
            // D. Construct Step
            compiledSteps.push({
                id: node.id,
                title: cleanData.label,
                message: cleanData.message || "",
                inputType: cleanData.inputType,
                options: cleanData.options,
                saveToField: cleanData.saveToField,
                nextStepId, 
                routes: Object.keys(routes).length > 0 ? routes : undefined, 
                mediaUrl: cleanData.mediaUrl,
                templateName: cleanData.templateName,
                mediaType: ['Video', 'Image', 'File'].includes(cleanData.label) ? cleanData.label.toLowerCase() : undefined,
                linkLabel: cleanData.linkLabel // Capture new field
            });
        });

        // 3. Fallback Entry Point
        if (!entryPointId && compiledSteps.length > 0) {
            entryPointId = compiledSteps[0].id;
        }

        // 4. Save
        try {
            // Refetch current settings to ensure we don't overwrite other fields like 'isEnabled'
            const currentSettings = isLiveMode ? await liveApiService.getBotSettings() : mockBackend.getBotSettings();
            
            const newSettings: BotSettings = {
                ...currentSettings,
                steps: compiledSteps,
                entryPointId,
                flowData: { nodes: nodes.map(n => ({...n, data: { ...n.data, icon: undefined }})), edges }
            };

            if (isLiveMode) await liveApiService.saveBotSettings(newSettings);
            else mockBackend.updateBotSettings(newSettings);
            
            setLastLoadedTime(Date.now()); // Mark successful save time
        } catch (e) { 
            console.error("Save Failed:", e);
            alert("Save failed. Please check connection."); 
        } finally {
            setIsSaving(false);
        }
    };

    const selectedNode = useMemo(() => nodes.find(n => n.id === selectedNodeId), [nodes, selectedNodeId]);

    // Error / Loading Overlay
    if (isLoading) {
        return (
            <div className="flex h-full items-center justify-center bg-slate-50 flex-col gap-4">
                <Loader2 size={48} className="text-blue-600 animate-spin" />
                <p className="text-gray-500 font-medium animate-pulse">Loading Bot Architecture...</p>
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="flex h-full items-center justify-center bg-slate-50 flex-col gap-4 p-8 text-center">
                <div className="bg-red-100 p-4 rounded-full">
                    <AlertTriangle size={48} className="text-red-600" />
                </div>
                <h3 className="text-xl font-bold text-gray-900">Connection Failed</h3>
                <p className="text-gray-600 max-w-md">
                    Could not load bot settings from the server. <br/>
                    The editor is locked to prevent data loss.
                </p>
                <div className="text-xs bg-gray-200 px-3 py-1 rounded text-gray-700 font-mono mt-2">{loadError}</div>
                <button 
                    onClick={loadData}
                    className="mt-4 px-6 py-2.5 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 flex items-center gap-2"
                >
                    <RefreshCw size={18} /> Retry Connection
                </button>
            </div>
        );
    }

    return (
        <div className="flex h-full bg-slate-50 font-sans relative overflow-hidden">
            <div className="w-64 bg-white border-r border-gray-200 flex flex-col z-10 shadow-lg">
                <div className="p-5 border-b border-gray-100">
                    <h2 className="font-bold text-gray-900 flex items-center gap-2 text-lg">
                        <Zap className="text-yellow-500 fill-yellow-500" size={20} /> Bot Studio
                    </h2>
                    <p className="text-xs text-gray-500 mt-1">Production Flow Builder</p>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-6">
                    <div>
                        <h4 className="text-[10px] font-bold text-gray-400 uppercase mb-3 tracking-wider">Messages</h4>
                        <div className="space-y-2">
                            <DraggableSidebarItem type="text" label="Text Message" icon={<MessageSquare size={16} />} />
                            <DraggableSidebarItem type="image" label="Image" icon={<ImageIcon size={16} />} />
                            <DraggableSidebarItem type="video" label="Video" icon={<Video size={16} />} />
                            <DraggableSidebarItem type="link" inputType="text" label="Link" icon={<Link size={16} />} />
                        </div>
                    </div>
                    <div>
                        <h4 className="text-[10px] font-bold text-gray-400 uppercase mb-3 tracking-wider">Interaction</h4>
                        <div className="space-y-2">
                            <DraggableSidebarItem type="option" inputType="option" label="Question" icon={<GitBranch size={16} />} />
                            <DraggableSidebarItem type="input" inputType="text" label="Collect Text" icon={<Type size={16} />} />
                        </div>
                    </div>
                </div>
            </div>

            <div className="flex-1 relative h-full flex flex-col">
                <div className="absolute top-4 right-4 z-20 flex gap-2">
                    <button onClick={handleSave} disabled={isSaving} className="bg-black text-white px-5 py-2.5 rounded-full text-sm font-bold shadow-lg hover:bg-gray-800 transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
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

            {selectedNode && (
                <PropertyInspector 
                    selectedNode={selectedNode} 
                    onChange={updateNodeData} 
                />
            )}
        </div>
    );
};
