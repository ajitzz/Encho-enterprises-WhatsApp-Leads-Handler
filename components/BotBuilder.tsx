
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
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
import { BotSettings, BotStep, MessageButton } from '../types';
import { mockBackend } from '../services/mockBackend';
import { liveApiService } from '../services/liveApiService';
import { useFlowStore } from '../services/flowStore'; 
import { MediaSelectorModal } from './MediaSelectorModal';
import { 
  MessageSquare, Image as ImageIcon, Video, List, Type, Hash, 
  LayoutGrid, X, Trash2, Zap, CheckCircle, Flag, ShieldAlert, 
  GripVertical, MousePointerClick, FileCode, Brush, Eye, 
  ChevronRight, Folder, ArrowLeft, Search, Cloud, Plus, Link, 
  HelpCircle, Split, GitBranch, ArrowRight, AlertTriangle, File, 
  Loader2, RefreshCw, Bold, Italic, CreditCard, MapPin, Phone, Globe, Clock, FileText
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
        case 'Rich Card': return <CreditCard size={14} />;
        case 'Image': return <ImageIcon size={14} />;
        case 'Video': return <Video size={14} />;
        case 'Document': return <FileText size={14} />;
        case 'Question':
        case 'Quick Reply': 
        case 'List': return <GitBranch size={14} />;
        case 'Collect Text': return <Type size={14} />;
        case 'Link': return <Link size={14} />;
        default: return <MessageSquare size={14} />;
    }
};

// --- NODE PREVIEW CARD ---
const NodePreviewCard = ({ data, id, selected }: any) => {
  const isMediaType = ['Image', 'Video'].includes(data.label);
  const isDocType = data.label === 'Document';
  const isOptionType = ['Quick Reply', 'List', 'Question'].includes(data.label) || data.inputType === 'option';
  const isCardType = data.label === 'Rich Card';
  const isLinkType = data.label === 'Link';
  
  // Validation Checks
  const hasPlaceholder = data.message && /replace\s+this|enter\s+your|type\s+your|sample\s+message/i.test(data.message);
  const isEmptyOptions = isOptionType && (!data.options || data.options.length === 0);
  const isEmptyMedia = (isMediaType || isDocType) && !data.mediaUrl;
  const isDanger = hasPlaceholder || isEmptyOptions || isEmptyMedia;

  let borderColor = 'border-gray-200';
  let accentColor = 'bg-gray-50';
  let iconColor = 'text-gray-500';

  if (isMediaType) { borderColor = 'border-amber-200'; accentColor = 'bg-amber-50'; iconColor = 'text-amber-600'; }
  else if (isDocType) { borderColor = 'border-orange-200'; accentColor = 'bg-orange-50'; iconColor = 'text-orange-600'; }
  else if (isOptionType) { borderColor = 'border-violet-300'; accentColor = 'bg-violet-50'; iconColor = 'text-violet-600'; }
  else if (isCardType) { borderColor = 'border-pink-300'; accentColor = 'bg-pink-50'; iconColor = 'text-pink-600'; }
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
                <div className="flex items-center gap-1 text-red-600" title="Validation Error">
                    <ShieldAlert size={16} className="animate-pulse" />
                </div>
            )}
        </div>

        {/* Body */}
        <div className="p-4">
            
            {/* Delay Indicator */}
            {data.delay > 0 && (
                <div className="mb-2 inline-flex items-center gap-1 text-[10px] font-mono font-bold bg-amber-50 text-amber-700 px-2 py-1 rounded border border-amber-200">
                    <Clock size={10} /> Wait {data.delay}s
                </div>
            )}

            {/* MEDIA PREVIEW (Image/Video) */}
            {isMediaType && (
                <div className="mb-3 rounded-lg bg-gray-100 border border-gray-200 aspect-video overflow-hidden relative flex items-center justify-center">
                    {data.mediaUrl ? (
                        data.label === 'Video' ? (
                            <video src={data.mediaUrl} className="w-full h-full object-cover" muted />
                        ) : (
                            <img src={data.mediaUrl} className="w-full h-full object-cover" alt="media" />
                        )
                    ) : (
                        <div className="flex flex-col items-center text-gray-400">
                            {data.label === 'Video' ? <Video size={24} /> : <ImageIcon size={24} />}
                            <span className="text-[10px] mt-1">No {data.label} Selected</span>
                        </div>
                    )}
                </div>
            )}

            {/* DOCUMENT PREVIEW */}
            {isDocType && (
                <div className="mb-3 p-3 rounded-lg bg-orange-50 border border-orange-200 flex items-center gap-3">
                    <div className="bg-white p-2 rounded border border-orange-100">
                        <FileText size={20} className="text-orange-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <span className="text-xs font-bold text-gray-800 block truncate">
                            {data.mediaUrl ? data.mediaUrl.split('/').pop() : 'No Document Selected'}
                        </span>
                        <span className="text-[10px] text-gray-500 uppercase">PDF / DOC</span>
                    </div>
                </div>
            )}

            {/* RICH CARD HEADER IMAGE */}
            {isCardType && data.headerImageUrl && (
                <div className="mb-3 rounded-t-lg bg-gray-100 border border-gray-200 aspect-video overflow-hidden relative">
                    <img src={data.headerImageUrl} className="w-full h-full object-cover" alt="header" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent flex items-end p-2">
                        {data.mediaLabel && <span className="text-white font-bold text-xs shadow-black drop-shadow-md">{data.mediaLabel}</span>}
                    </div>
                </div>
            )}

            {/* TEMPLATE BADGE */}
            {isCardType && data.templateName && (
                <div className="mb-2 bg-green-50 text-green-800 text-[10px] font-bold px-2 py-1 rounded border border-green-200 flex items-center gap-1">
                    <CheckCircle size={10} /> Template: {data.templateName}
                </div>
            )}

            {/* Message Text */}
            {data.label !== 'Image' && data.label !== 'Video' && data.label !== 'Document' && (
                <div className="bg-gray-50 p-3 rounded-lg border border-gray-100 mb-3 relative overflow-hidden">
                    <p className={`text-xs leading-relaxed font-medium whitespace-pre-wrap ${hasPlaceholder ? 'text-red-600 font-bold' : 'text-gray-700'}`}>
                        {data.message || <span className="italic text-gray-300">No content...</span>}
                    </p>
                    {isCardType && data.footerText && (
                        <p className="text-[10px] text-gray-400 mt-2 border-t border-gray-200 pt-1">{data.footerText}</p>
                    )}
                </div>
            )}

            {/* Caption for Media Nodes */}
            {(isMediaType || isDocType) && data.message && (
                <div className="bg-gray-50 p-2 rounded border border-gray-100 mb-3">
                    <p className="text-xs text-gray-600 italic">Caption: {data.message}</p>
                </div>
            )}

            {/* RICH CARD BUTTONS */}
            {isCardType && data.buttons && data.buttons.length > 0 && (
                <div className="space-y-1">
                    {data.buttons.map((btn: MessageButton, i: number) => (
                        <div key={i} className="flex items-center justify-center gap-2 w-full py-2 bg-white border border-gray-200 rounded-md shadow-sm text-xs font-bold text-blue-600 group/btn relative">
                            {btn.type === 'location' && <MapPin size={10} />}
                            {btn.type === 'url' && <Globe size={10} />}
                            {btn.type === 'phone' && <Phone size={10} />}
                            {btn.type === 'reply' && <div className="absolute right-[-10px]"><Handle type="source" position={Position.Right} id={`btn-${i}`} style={OPTION_HANDLE_STYLE} /></div>}
                            {btn.title}
                        </div>
                    ))}
                </div>
            )}

            {/* Legacy Options Routing */}
            {isOptionType && (
                <div className="mt-4 space-y-3">
                    {data.options?.map((opt: string, i: number) => (
                        <div key={i} className="relative flex items-center justify-between bg-white border-2 border-gray-100 px-3 py-3 rounded-lg shadow-sm">
                            <span className="text-xs font-bold text-gray-700">{opt || '(Empty)'}</span>
                            <Handle type="source" position={Position.Right} id={`option-${i}`} style={OPTION_HANDLE_STYLE} />
                        </div>
                    ))}
                </div>
            )}
        </div>

        {/* Fallback Main Output */}
        {!isOptionType && (!isCardType || !data.buttons?.some((b: any) => b.type === 'reply')) && (
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
    const [pickerTarget, setPickerTarget] = useState<'header' | 'main'>('main');

    useEffect(() => { setLocalData(selectedNode.data); }, [selectedNode]);

    // Atomic Update (Fixes Double-Update Race Condition)
    const update = (updates: Record<string, any> | string, value?: any) => {
        let newData;
        if (typeof updates === 'string') {
            newData = { ...localData, [updates]: value };
        } else {
            newData = { ...localData, ...updates };
        }
        
        setLocalData(newData);
        onChange(selectedNode.id, newData);
    };

    const addButton = () => {
        const newButtons = [...(localData.buttons || []), { type: 'reply', title: 'New Button' }];
        update('buttons', newButtons);
    };

    const updateButton = (index: number, key: string, val: string) => {
        const newButtons = [...(localData.buttons || [])];
        newButtons[index] = { ...newButtons[index], [key]: val };
        update('buttons', newButtons);
    };

    const removeButton = (index: number) => {
        const newButtons = localData.buttons.filter((_: any, i: number) => i !== index);
        update('buttons', newButtons);
    };

    const handleMediaSelect = (url: string, type: string) => {
        if (pickerTarget === 'header') {
            update('headerImageUrl', url);
        } else {
            // Batch update to ensure both URL and Type are saved before re-render
            update({ mediaUrl: url, mediaType: type });
        }
        setShowMediaPicker(false);
    };

    const isCardType = localData.label === 'Rich Card';
    const isMediaNode = ['Image', 'Video', 'Document'].includes(localData.label);

    return (
        <div className="w-80 bg-white border-l border-gray-200 flex flex-col h-full shadow-xl z-20">
            <div className="px-5 py-4 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
                <h3 className="font-bold text-gray-800">{localData.label} Properties</h3>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-6">
                
                {/* DELAY SETTING */}
                <div className="space-y-2 pb-4 border-b border-gray-100">
                    <label className="text-xs font-bold text-amber-600 uppercase flex items-center gap-2">
                        <Clock size={12} /> Response Delay (Seconds)
                    </label>
                    <input 
                        type="number"
                        min="0"
                        className="w-full p-2 bg-white border border-gray-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-amber-500"
                        value={localData.delay || 0}
                        onChange={(e) => update('delay', parseInt(e.target.value) || 0)}
                    />
                    <p className="text-[9px] text-gray-400">Time to wait before sending this message.</p>
                </div>

                {/* TEMPLATE NAME FIELD */}
                {isCardType && (
                    <div className="space-y-2 pb-4 border-b border-gray-100">
                        <label className="text-xs font-bold text-gray-500 uppercase">Meta Template Name</label>
                        <input 
                            className="w-full p-2 bg-white border border-gray-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-green-500"
                            value={localData.templateName || ''}
                            onChange={(e) => update('templateName', e.target.value)}
                            placeholder="e.g. welcome_offer_v2"
                        />
                        <p className="text-[9px] text-gray-400">Required if using Link/Location buttons.</p>
                    </div>
                )}

                {/* Header Image for Card */}
                {isCardType && (
                    <div className="space-y-2">
                        <label className="text-xs font-bold text-gray-500 uppercase">Header Image</label>
                        {localData.headerImageUrl ? (
                            <div className="relative aspect-video rounded-lg overflow-hidden border border-gray-200 group">
                                <img src={localData.headerImageUrl} className="w-full h-full object-cover" alt="Header" />
                                <button onClick={() => update('headerImageUrl', '')} className="absolute top-1 right-1 bg-red-500 text-white p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"><Trash2 size={12} /></button>
                            </div>
                        ) : (
                            <button 
                                onClick={() => { setPickerTarget('header'); setShowMediaPicker(true); }} 
                                className="w-full py-6 border-2 border-dashed border-gray-200 rounded-lg text-gray-400 hover:border-blue-300 hover:text-blue-500 flex flex-col items-center gap-2 transition-colors"
                            >
                                <ImageIcon size={20} />
                                <span className="text-xs font-medium">Select Header from Library</span>
                            </button>
                        )}
                    </div>
                )}

                {/* MAIN MEDIA SELECTOR (Image, Video, Document) */}
                {isMediaNode && (
                    <div className="space-y-2 pb-4 border-b border-gray-100">
                        <label className="text-xs font-bold text-gray-500 uppercase">{localData.label} Source</label>
                        {localData.mediaUrl ? (
                            <div className="relative rounded-lg bg-gray-50 border border-gray-200 p-2 flex items-center gap-2 group">
                                {localData.label === 'Video' ? <Video size={16} className="text-purple-500" /> : 
                                 localData.label === 'Document' ? <FileText size={16} className="text-orange-500" /> : 
                                 <ImageIcon size={16} className="text-blue-500" />}
                                
                                <span className="text-xs text-gray-700 truncate flex-1" title={localData.mediaUrl}>
                                    {localData.mediaUrl.split('/').pop()}
                                </span>
                                
                                <button 
                                    onClick={() => update({ mediaUrl: '', mediaType: '' })} 
                                    className="text-red-500 p-1 hover:bg-red-50 rounded"
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>
                        ) : (
                            <button 
                                onClick={() => { setPickerTarget('main'); setShowMediaPicker(true); }}
                                className="w-full py-4 border-2 border-dashed border-gray-200 rounded-lg text-gray-500 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 transition-all flex flex-col items-center gap-1"
                            >
                                <Cloud size={20} />
                                <span className="text-xs font-bold">Select {localData.label} from S3 Library</span>
                            </button>
                        )}
                    </div>
                )}

                {/* Body Text */}
                <div className="space-y-2">
                    <label className="text-xs font-bold text-gray-500 uppercase">
                        {isMediaNode ? 'Caption (Optional)' : 'Message Body'}
                    </label>
                    <textarea 
                        className="w-full h-32 p-3 bg-white border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-none"
                        value={localData.message || ''}
                        onChange={(e) => update('message', e.target.value)}
                        placeholder="Type message text..."
                    />
                </div>

                {/* Footer Text */}
                {isCardType && (
                    <div className="space-y-2">
                        <label className="text-xs font-bold text-gray-500 uppercase">Footer (Optional)</label>
                        <input 
                            className="w-full p-2 bg-white border border-gray-200 rounded-lg text-xs outline-none"
                            value={localData.footerText || ''}
                            onChange={(e) => update('footerText', e.target.value)}
                            placeholder="e.g. Reply STOP to unsubscribe"
                        />
                    </div>
                )}

                {/* Buttons Manager */}
                {isCardType && (
                    <div className="space-y-3 pt-4 border-t border-gray-100">
                        <div className="flex justify-between items-center">
                            <label className="text-xs font-bold text-gray-500 uppercase">Buttons</label>
                            <button onClick={addButton} className="text-xs text-blue-600 font-bold hover:underline">+ Add Button</button>
                        </div>
                        <div className="space-y-3">
                            {(localData.buttons || []).map((btn: MessageButton, i: number) => (
                                <div key={i} className="bg-gray-50 p-2 rounded-lg border border-gray-200 space-y-2">
                                    <div className="flex gap-2">
                                        <select 
                                            value={btn.type}
                                            onChange={(e) => updateButton(i, 'type', e.target.value)}
                                            className="bg-white border border-gray-200 text-xs rounded p-1 w-24 outline-none"
                                        >
                                            <option value="reply">Reply</option>
                                            <option value="url">Link</option>
                                            <option value="location">Location</option>
                                            <option value="phone">Call</option>
                                        </select>
                                        <input 
                                            value={btn.title}
                                            onChange={(e) => updateButton(i, 'title', e.target.value)}
                                            className="flex-1 bg-white border border-gray-200 text-xs rounded p-1 outline-none"
                                            placeholder="Label"
                                        />
                                        <button onClick={() => removeButton(i)} className="text-red-400 hover:text-red-600"><X size={14} /></button>
                                    </div>
                                    {btn.type !== 'reply' && btn.type !== 'location' && (
                                        <input 
                                            value={btn.payload || ''}
                                            onChange={(e) => updateButton(i, 'payload', e.target.value)}
                                            className="w-full bg-white border border-gray-200 text-xs rounded p-1 outline-none"
                                            placeholder={btn.type === 'url' ? 'https://...' : 'Payload/ID...'}
                                        />
                                    )}
                                     {btn.type === 'reply' && (
                                        <input 
                                            value={btn.payload || ''}
                                            onChange={(e) => updateButton(i, 'payload', e.target.value)}
                                            className="w-full bg-white border border-gray-200 text-xs rounded p-1 outline-none"
                                            placeholder="Optional ID (e.g. btn_yes)"
                                        />
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
            
            <MediaSelectorModal 
                isOpen={showMediaPicker} 
                onClose={() => setShowMediaPicker(false)}
                onSelect={handleMediaSelect}
                allowedType={
                    pickerTarget === 'header' ? 'Image' : 
                    localData.label === 'Image' ? 'Image' : 
                    localData.label === 'Video' ? 'Video' : 
                    localData.label === 'Document' ? 'Document' : 'All'
                }
            />
        </div>
    );
};

// ... (Rest of file including DraggableSidebarItem and FlowEditor remains the same) ...
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

    const loadData = useCallback(async () => {
        setIsLoading(true);
        setLoadError(null);
        try {
            const settings = isLiveMode ? await liveApiService.getBotSettings() : mockBackend.getBotSettings();
            if (settings.flowData && settings.flowData.nodes.length > 0) {
                const cleanNodes = settings.flowData.nodes.map((n: any) => {
                    const { icon, ...cleanData } = n.data || {};
                    return { ...n, data: cleanData };
                });
                setNodes(cleanNodes);
                setEdges(settings.flowData.edges);
            } else {
                resetFlow(); 
            }
        } catch (e: any) {
            setLoadError(e.message || "Failed to load bot flow");
        } finally {
            setIsLoading(false);
        }
    }, [isLiveMode, setNodes, setEdges, resetFlow]);
    
    useEffect(() => { loadData(); }, [loadData]);

    const onDragOver = useCallback((event: React.DragEvent) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }, []);
    const onDrop = useCallback((event: React.DragEvent) => {
        event.preventDefault();
        const type = event.dataTransfer.getData('application/reactflow/type');
        let inputType = event.dataTransfer.getData('application/reactflow/inputType');
        const label = event.dataTransfer.getData('application/reactflow/label');
        if (!type) return;

        const position = { x: event.clientX - 300, y: event.clientY };
        const newNode: Node = {
            id: `node_${Date.now()}`,
            type: 'custom',
            position,
            data: { 
                label, 
                message: '', 
                inputType,
                buttons: [], // Init for cards
                headerImageUrl: '',
                mediaUrl: '',
                mediaType: '',
                templateName: '',
                delay: 0
            },
        };
        addNode(newNode);
        setSelectedNodeId(newNode.id);
    }, [addNode]);

    const handleSave = async () => {
        setIsSaving(true);
        const compiledSteps: BotStep[] = [];
        const startEdge = edges.find(e => e.source === 'start');
        let entryPointId = startEdge?.target;
        
        nodes.forEach(node => {
            const data = node.data as any;
            if (data.type === 'start') return;
            
            const outgoingEdges = edges.filter(e => e.source === node.id);
            let nextStepId: string | undefined = 'END'; 
            let routes: Record<string, string> = {};

            const mainEdge = outgoingEdges.find(e => e.sourceHandle === 'main' || !e.sourceHandle);
            if (mainEdge) nextStepId = mainEdge.target;

            // Handle Reply Buttons Routing
            if (data.buttons) {
                data.buttons.forEach((btn: MessageButton, idx: number) => {
                    if (btn.type === 'reply') {
                        const handleId = `btn-${idx}`;
                        const edge = outgoingEdges.find(e => e.sourceHandle === handleId);
                        // Fix: Routing Key Priority -> Payload > Title
                        // This matches backend logic to prefer IDs over text
                        if (edge) {
                            const key = btn.payload || btn.title;
                            routes[key] = edge.target;
                        }
                    }
                });
            }
            
            // Legacy Options Routing
            if (data.options) {
                data.options.forEach((opt: string, idx: number) => {
                     const handleId = `option-${idx}`;
                     const edge = outgoingEdges.find(e => e.sourceHandle === handleId);
                     if (edge) routes[opt] = edge.target;
                });
            }
            
            const { icon, ...cleanData } = data;
            
            if (cleanData.label === 'Text Message') {
                delete cleanData.options;
                delete cleanData.saveToField;
            }

            compiledSteps.push({
                id: node.id,
                title: cleanData.label,
                message: cleanData.message || "",
                inputType: cleanData.inputType,
                options: cleanData.options,
                buttons: cleanData.buttons,
                headerImageUrl: cleanData.headerImageUrl,
                footerText: cleanData.footerText,
                templateName: cleanData.templateName,
                delay: cleanData.delay,
                saveToField: cleanData.saveToField,
                nextStepId, 
                routes: Object.keys(routes).length > 0 ? routes : undefined, 
                mediaUrl: cleanData.mediaUrl,
                mediaType: cleanData.mediaType,
                linkLabel: cleanData.linkLabel
            });
        });

        if (!entryPointId && compiledSteps.length > 0) entryPointId = compiledSteps[0].id;

        try {
            const currentSettings = isLiveMode ? await liveApiService.getBotSettings() : mockBackend.getBotSettings();
            const newSettings: BotSettings = {
                ...currentSettings,
                steps: compiledSteps,
                entryPointId,
                flowData: { nodes: nodes.map(n => ({...n, data: { ...n.data, icon: undefined }})), edges }
            };

            if (isLiveMode) await liveApiService.saveBotSettings(newSettings);
            else mockBackend.updateBotSettings(newSettings);
        } catch (e) { 
            alert("Save failed. Please check connection."); 
        } finally {
            setIsSaving(false);
        }
    };

    const selectedNode = useMemo(() => nodes.find(n => n.id === selectedNodeId), [nodes, selectedNodeId]);

    if (isLoading) return <div className="flex h-full items-center justify-center bg-slate-50"><Loader2 size={48} className="text-blue-600 animate-spin" /></div>;

    return (
        <div className="flex h-full bg-slate-50 font-sans relative overflow-hidden">
            <div className="w-64 bg-white border-r border-gray-200 flex flex-col z-10 shadow-lg">
                <div className="p-5 border-b border-gray-100">
                    <h2 className="font-bold text-gray-900 flex items-center gap-2 text-lg"><Zap className="text-yellow-500 fill-yellow-500" size={20} /> Bot Studio</h2>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-6">
                    <div>
                        <h4 className="text-[10px] font-bold text-gray-400 uppercase mb-3 tracking-wider">Rich Content</h4>
                        <div className="space-y-2">
                            <DraggableSidebarItem type="card" inputType="card" label="Rich Card" icon={<CreditCard size={16} />} />
                            <DraggableSidebarItem type="image" label="Image" icon={<ImageIcon size={16} />} />
                            <DraggableSidebarItem type="video" label="Video" icon={<Video size={16} />} />
                            <DraggableSidebarItem type="document" label="Document" icon={<FileText size={16} />} />
                        </div>
                    </div>
                    <div>
                        <h4 className="text-[10px] font-bold text-gray-400 uppercase mb-3 tracking-wider">Basic</h4>
                        <div className="space-y-2">
                            <DraggableSidebarItem type="text" label="Text Message" icon={<MessageSquare size={16} />} />
                            <DraggableSidebarItem type="option" inputType="option" label="Question" icon={<GitBranch size={16} />} />
                            <DraggableSidebarItem type="input" inputType="text" label="Collect Text" icon={<Type size={16} />} />
                        </div>
                    </div>
                </div>
            </div>

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

            {selectedNode && (
                <PropertyInspector 
                    selectedNode={selectedNode} 
                    onChange={updateNodeData} 
                />
            )}
        </div>
    );
};
