
import React, { useState, useEffect, useMemo } from 'react';
import { 
  ReactFlow, 
  MiniMap, 
  Controls, 
  Background, 
  BackgroundVariant, 
  Handle, 
  Position,
  useReactFlow,
  Node,
  useNodesState,
  useEdgesState,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useFlowStore } from '../services/flowStore';
import { liveApiService } from '../services/liveApiService';
import { mockBackend } from '../services/mockBackend';
import { AITraining } from './AITraining';
import { 
  MessageSquare, List, GitBranch, Save, Play, Trash2, X, Zap, 
  Image as ImageIcon, MousePointer, Settings, GripVertical, Plus, 
  ListPlus, LayoutTemplate, RefreshCw, User, Check, Clock, MapPin, 
  CreditCard, FileText, Type, Variable, CornerRightDown, Navigation,
  LocateFixed, AlertTriangle, Bot, CalendarClock, Calendar, FileCheck,
  Sparkles, TimerReset
} from 'lucide-react';
import { FlowNodeData, NodeType, ListSection, LocationPreset, SummaryFieldConfig, SummaryTextStyle } from '../types';

const inferCapturedVariableNames = (data: FlowNodeData, nodeId?: string): string[] => {
    const variables = new Set<string>();

    if (data.variable) variables.add(String(data.variable).trim());

    if (data.type === 'datetime_picker') {
        ['pickup_date', 'time_period', 'time_slot'].forEach(v => variables.add(v));
    }

    if (data.type === 'pickup_location') variables.add('pickup_coords');
    if (data.type === 'destination_location') variables.add('dest_coords');
    if (data.type === 'location_request') variables.add('location_data');

    const captureTypes: NodeType[] = ['input', 'interactive_button', 'interactive_list', 'rich_card'];
    if (captureTypes.includes(data.type) && !data.variable) {
        const fallback = (data.label || nodeId || '').toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/^_+|_+$/g, '');
        if (fallback) variables.add(fallback);
    }

    return Array.from(variables).filter(Boolean);
};

const labelFromVariable = (variable: string) => variable.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// --- 1. ADVANCED NODE COMPONENT (VISUALIZER) ---

const NodeHeader = ({ color, icon, label, selected, subtitle }: any) => (
    <div className={`px-4 py-2.5 flex items-center gap-3 border-b border-gray-100 rounded-t-xl transition-colors ${selected ? 'bg-blue-50/80' : 'bg-white'}`}>
        <div className={`p-1.5 rounded-lg ${color} text-white shadow-sm shrink-0`}>
            {icon}
        </div>
        <div className="flex flex-col min-w-0">
            <span className="font-extrabold text-[11px] text-gray-700 uppercase tracking-wider truncate">{label}</span>
            {subtitle && <span className="text-[10px] text-gray-400 truncate font-medium">{subtitle}</span>}
        </div>
        <GripVertical size={14} className="text-gray-300 opacity-0 group-hover:opacity-100 cursor-grab ml-auto" />
    </div>
);

const UniversalNode = ({ data, selected }: { data: FlowNodeData, selected: boolean, id: string }) => {
    let config = { color: 'bg-slate-600', icon: <MessageSquare size={14} />, label: 'Message', subtitle: '' };
    
    switch(data.type) {
        case 'start': config = { color: 'bg-emerald-500', icon: <Zap size={14} />, label: 'Start Flow', subtitle: 'Entry Point' }; break;
        case 'text': config = { color: 'bg-blue-500', icon: <Type size={14} />, label: 'Text Message', subtitle: 'Simple Reply' }; break;
        case 'image': config = { color: 'bg-purple-500', icon: <ImageIcon size={14} />, label: 'Media', subtitle: 'Image/Video' }; break;
        case 'rich_card': config = { color: 'bg-pink-600', icon: <CreditCard size={14} />, label: 'Rich Card', subtitle: 'Media + Buttons' }; break;
        case 'input': config = { color: 'bg-orange-500', icon: <CornerRightDown size={14} />, label: 'Collect Input', subtitle: 'Wait for user' }; break;
        case 'interactive_button': config = { color: 'bg-rose-500', icon: <MousePointer size={14} />, label: 'Buttons', subtitle: 'Quick Reply' }; break;
        case 'interactive_list': config = { color: 'bg-indigo-500', icon: <List size={14} />, label: 'List Menu', subtitle: 'Up to 10 Options' }; break;
        case 'condition': config = { color: 'bg-amber-500', icon: <GitBranch size={14} />, label: 'Logic Check', subtitle: 'If/Else' }; break;
        case 'set_variable': config = { color: 'bg-cyan-600', icon: <Variable size={14} />, label: 'Set Variable', subtitle: 'Update Data' }; break;
        case 'delay': config = { color: 'bg-gray-500', icon: <Clock size={14} />, label: 'Smart Delay', subtitle: 'Human Pause' }; break;
        case 'location_request': config = { color: 'bg-teal-600', icon: <MapPin size={14} />, label: 'Location', subtitle: 'Request GPS' }; break;
        case 'pickup_location': config = { color: 'bg-lime-600', icon: <MapPin size={14} />, label: 'Pickup Location', subtitle: 'Get Start Point' }; break;
        case 'destination_location': config = { color: 'bg-red-500', icon: <Navigation size={14} />, label: 'Destination', subtitle: 'Get End Point' }; break;
        case 'summary': config = { color: 'bg-violet-600', icon: <FileCheck size={14} />, label: 'Advanced Summary', subtitle: 'Styled Variable Report' }; break;
        case 'datetime_picker': config = { color: 'bg-cyan-600', icon: <CalendarClock size={14} />, label: 'Smart Scheduler', subtitle: 'Date → Period → Time' }; break;
        case 'handoff': config = { color: 'bg-red-500', icon: <User size={14} />, label: 'Agent Handoff', subtitle: 'Stop Bot' }; break;
        case 'status_update': config = { color: 'bg-green-600', icon: <Check size={14} />, label: 'Set Status', subtitle: 'CRM Update' }; break;
    }

    return (
        <div className={`w-[280px] bg-white rounded-xl shadow-lg transition-all duration-200 group border-2 ${selected ? 'border-blue-500 ring-2 ring-blue-100' : 'border-transparent hover:border-gray-300'}`}>
            <NodeHeader {...config} selected={selected} />
            
            <div className="p-4 text-sm text-gray-600 relative bg-white rounded-b-xl min-h-[60px]">
                {/* Input Handle */}
                {data.type !== 'start' && (
                    <Handle type="target" position={Position.Left} className="!w-3.5 !h-3.5 !bg-slate-500 !border-4 !border-white !-left-[19px] !shadow-sm" />
                )}

                {/* --- CONTENT PREVIEWS --- */}
                
                {/* 1. Header Media Preview (Rich Cards) */}
                {(data.mediaUrl || data.headerType === 'image') && (
                    <div className="mb-3 rounded-lg overflow-hidden h-28 bg-gray-100 border border-gray-100 flex items-center justify-center relative group/media">
                        {data.mediaUrl ? (
                            <img src={data.mediaUrl} className="h-full w-full object-cover" alt="media" />
                        ) : (
                             <div className="flex flex-col items-center gap-1 text-gray-400">
                                 <ImageIcon size={24} />
                                 <span className="text-[10px] uppercase font-bold">No Image Set</span>
                             </div>
                        )}
                        <div className="absolute top-1 right-1 bg-black/50 text-white text-[9px] px-1.5 py-0.5 rounded font-bold uppercase backdrop-blur-sm">
                             {data.headerType || 'Media'}
                        </div>
                    </div>
                )}

                {/* 2. Text Content */}
                {data.type !== 'delay' && data.type !== 'set_variable' && data.type !== 'summary' && data.type !== 'datetime_picker' && (
                    <div className="text-xs mb-3 text-gray-800 leading-relaxed font-medium">
                        {data.content ? (
                            <div className="whitespace-pre-wrap">{data.content}</div>
                        ) : (
                            <span className="text-gray-400 italic">Click to configure message...</span>
                        )}
                    </div>
                )}

                {/* 3. Footer Preview */}
                {data.footerText && (
                    <div className="text-[10px] text-gray-400 mb-3 pt-2 border-t border-gray-50 flex items-center gap-1">
                        <span className="truncate">{data.footerText}</span>
                    </div>
                )}

                {/* 4. Special Node Previews */}
                {data.type === 'delay' && (
                    <div className="flex items-center justify-center gap-2 text-gray-500 py-2 bg-gray-50 rounded-lg border border-gray-100 border-dashed">
                        <Clock size={16} className="animate-pulse" />
                        <span className="font-bold font-mono text-xs">Wait {data.delayTime ? (data.delayTime/1000) : 2}s</span>
                    </div>
                )}
                
                {data.type === 'summary' && (
                    <div className="flex flex-col gap-2 p-2 bg-violet-50 rounded-lg border border-violet-100">
                        <div className="text-[10px] text-violet-800 font-bold mb-1 uppercase">Advanced Summary</div>
                        <div className="text-[10px] text-gray-600 leading-relaxed">
                            <div className="font-semibold text-violet-700">{data.content || 'Summary'}</div>
                            {data.summaryDescription && <div className="text-gray-500">{data.summaryDescription}</div>}
                            <div className="mt-1 text-violet-500 font-mono">Rows: {(data.summaryFields || []).length || 'Auto'}</div>
                            {data.footerText && <div className="text-gray-400 italic">{data.footerText}</div>}
                        </div>
                    </div>
                )}
                
                {data.type === 'datetime_picker' && (
                    <div className="flex flex-col gap-2 p-2.5 bg-gradient-to-br from-cyan-50 via-sky-50 to-indigo-50 rounded-lg border border-cyan-100">
                        <div className="flex items-center justify-between text-[9px] font-bold text-cyan-900 uppercase border-b border-cyan-200 pb-1.5 mb-1">
                            <span className="flex items-center gap-1"><Sparkles size={10}/> Smart Scheduler V2</span>
                            <span>Checkpoint Safe-Run</span>
                        </div>
                        <div className="grid grid-cols-2 gap-1.5 text-[9px]">
                            <div className="bg-white/80 rounded border border-cyan-100 px-1.5 py-1">
                                <div className="text-[8px] text-gray-400 uppercase">Date Window</div>
                                <div className="font-bold text-cyan-800">{data?.dateConfig?.daysToShow || 7} days</div>
                            </div>
                            <div className="bg-white/80 rounded border border-cyan-100 px-1.5 py-1">
                                <div className="text-[8px] text-gray-400 uppercase">Buffer</div>
                                <div className="font-bold text-cyan-800">+30m safety</div>
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            <div className="flex items-center gap-2 text-[10px] text-gray-700 bg-white p-1.5 rounded border border-gray-100">
                                <Calendar size={12} className="text-cyan-500"/>
                                <div className="flex-1 flex flex-col">
                                    <span className="font-bold">1. Date</span>
                                    <span className="text-[8px] text-gray-400">Today, Tomorrow, custom date</span>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 text-[10px] text-gray-700 bg-white p-1.5 rounded border border-gray-100">
                                <TimerReset size={12} className="text-amber-500"/>
                                <div className="flex-1 flex flex-col">
                                    <span className="font-bold">2. Period</span>
                                    <span className="text-[8px] text-gray-400">Morning/Afternoon/Evening/Night</span>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 text-[10px] text-gray-700 bg-white p-1.5 rounded border border-gray-100">
                                <Clock size={12} className="text-cyan-500"/>
                                <div className="flex-1 flex flex-col">
                                    <span className="font-bold">3. Time Slot</span>
                                    <span className="text-[8px] text-gray-400">Period-based 30-minute slots</span>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
                
                {(data.type === 'pickup_location' || data.type === 'destination_location') && (
                    <div className="flex flex-col gap-2">
                        {/* Status Banner */}
                        <div className={`flex items-center justify-center gap-2 py-2 rounded-lg border text-xs font-bold font-mono uppercase tracking-wide ${data.type === 'pickup_location' ? 'bg-lime-50 text-lime-700 border-lime-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
                            {data.type === 'pickup_location' ? <MapPin size={12}/> : <Navigation size={12}/>}
                            {data.type === 'pickup_location' ? 'Saves to: pickup_coords' : 'Saves to: dest_coords'}
                        </div>
                        
                        {/* Presets Preview */}
                        {data.presets && data.presets.length > 0 && (
                            <div className="space-y-1">
                                <div className="flex justify-between items-center text-[9px] font-bold text-gray-400 uppercase tracking-wider pl-1">
                                    <span>Smart Presets</span>
                                    <span>{data.presets.length}</span>
                                </div>
                                {data.presets.slice(0, 3).map((preset) => (
                                    <div key={preset.id} className="flex items-center gap-2 bg-gray-50 px-2 py-1.5 rounded border border-gray-100">
                                        {preset.type === 'manual' ? (
                                            <LocateFixed size={10} className="text-blue-500" />
                                        ) : (
                                            <div className="w-2.5 h-2.5 rounded-full bg-green-400"></div>
                                        )}
                                        <span className="text-[10px] font-medium text-gray-700 truncate flex-1">{preset.title}</span>
                                        {preset.type === 'static' && (
                                            <span className="text-[8px] font-mono text-gray-400">{preset.latitude?.toFixed(2)}, {preset.longitude?.toFixed(2)}</span>
                                        )}
                                    </div>
                                ))}
                                {data.presets.length > 3 && (
                                    <div className="text-[9px] text-center text-gray-400 italic">+{data.presets.length - 3} more...</div>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {data.type === 'set_variable' && (
                    <div className="bg-cyan-50 text-cyan-800 p-2 rounded-lg border border-cyan-100 text-xs font-mono">
                        <div className="font-bold">{data.variable || 'var_name'}</div>
                        <div className="text-[10px] opacity-70">= {data.operationValue || 'value'}</div>
                    </div>
                )}

                {/* --- DYNAMIC OUTPUT HANDLES --- */}

                {/* Buttons (Interactive & Rich Card) */}
                {(data.type === 'interactive_button' || data.type === 'rich_card') && (
                    <div className="flex flex-col gap-2 mt-2">
                        {(data.buttons || []).map((btn) => (
                            <div key={btn.id} className="relative bg-gray-50 text-blue-600 text-xs py-2 px-3 rounded-lg text-center font-bold border border-gray-200 shadow-sm hover:bg-blue-50 transition-colors">
                                {btn.title}
                                <Handle 
                                    type="source" 
                                    position={Position.Right} 
                                    id={btn.id} 
                                    className="!bg-blue-500 !w-3 !h-3 !border-2 !border-white !-right-[20px] top-1/2 !transform-none !-mt-1.5" 
                                />
                            </div>
                        ))}
                    </div>
                )}

                {/* List Menu */}
                {data.type === 'interactive_list' && (
                    <div className="space-y-1 mt-2">
                        <div className="text-center p-1.5 bg-indigo-50 text-indigo-700 text-[10px] font-bold uppercase rounded border border-indigo-100 mb-2">
                            {data.listButtonText || 'Menu'}
                        </div>
                        {data.sections?.flatMap(s => s.rows).slice(0, 5).map((row) => (
                            <div key={row.id} className="relative flex items-center justify-between bg-white px-3 py-2 rounded border border-gray-100 shadow-sm">
                                <span className="text-[11px] font-medium text-gray-700 truncate pr-2">{row.title}</span>
                                <Handle 
                                    type="source" 
                                    position={Position.Right} 
                                    id={row.id} 
                                    className="!w-2.5 !h-2.5 !bg-indigo-500 !border-2 !border-white !-right-[19px]" 
                                />
                            </div>
                        ))}
                        {(data.sections?.flatMap(s => s.rows).length || 0) > 5 && (
                            <div className="text-center text-[9px] text-gray-400 italic">...and more</div>
                        )}
                    </div>
                )}

                {/* Conditions (True/False) */}
                {data.type === 'condition' && (
                    <div className="mt-2 space-y-2.5">
                        <div className="relative flex justify-between items-center text-[10px] font-bold text-green-700 bg-green-50 p-2 rounded border border-green-200">
                            <span>TRUE (Match)</span>
                            <Handle type="source" position={Position.Right} id="true" className="!bg-green-500 !w-3 !h-3 !border-2 !border-white !-right-[20px]" />
                        </div>
                        <div className="relative flex justify-between items-center text-[10px] font-bold text-red-700 bg-red-50 p-2 rounded border border-red-200">
                            <span>FALSE (Else)</span>
                            <Handle type="source" position={Position.Right} id="false" className="!bg-red-500 !w-3 !h-3 !border-2 !border-white !-right-[20px]" />
                        </div>
                    </div>
                )}

                {/* Default Output (Next Step) */}
                {!['interactive_button', 'interactive_list', 'rich_card', 'condition', 'handoff'].includes(data.type) && (
                    <Handle 
                        type="source" 
                        position={Position.Right} 
                        className={`!w-3.5 !h-3.5 !border-4 !border-white !-right-[19px] !shadow-sm ${config.color.replace('bg-', '!bg-')}`} 
                    />
                )}
            </div>
        </div>
    );
};

// --- 2. PROPERTIES PANEL (THE EDITOR) ---

const PropertiesPanel = ({ node, onChange, onClose }: { node: Node<FlowNodeData>, onChange: (id: string, d: any) => void, onClose: () => void }) => {
    const [local, setLocal] = useState(node.data);
    const [activeTab, setActiveTab] = useState<'content' | 'settings'>('content');
    const allNodes = useFlowStore((state) => state.nodes);

    const detectedVariables = useMemo(() => {
        const vars = new Set<string>();
        allNodes
            .filter(n => n.id !== node.id)
            .forEach((n) => {
                inferCapturedVariableNames(n.data as FlowNodeData, n.id).forEach((variableName) => vars.add(variableName));
            });
        return Array.from(vars);
    }, [allNodes, node.id]);
    
    useEffect(() => setLocal(node.data), [node.id]);

    const update = (k: string, v: any) => {
        const n = { ...local, [k]: v };
        setLocal(n);
        onChange(node.id, n);
    };

    const updateSummaryFields = (fields: SummaryFieldConfig[]) => update('summaryFields', fields);

    return (
        <div className="w-[420px] bg-white border-l border-gray-200 h-full flex flex-col shadow-2xl z-30 animate-in slide-in-from-right duration-300 absolute right-0 top-0 bottom-0">
            {/* Header */}
            <div className="px-6 py-5 border-b bg-gray-50 flex justify-between items-center shrink-0">
                <div>
                    <h3 className="font-extrabold text-gray-900 text-sm uppercase tracking-wide flex items-center gap-2">
                        <Settings size={16} className="text-blue-600" />
                        {local.type.replace(/_/g, ' ')}
                    </h3>
                    <p className="text-[10px] text-gray-500 font-mono mt-1">Node ID: {node.id}</p>
                </div>
                <button onClick={onClose} className="p-1.5 hover:bg-gray-200 rounded-full transition-colors"><X size={18} /></button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-200 bg-white">
                <button onClick={() => setActiveTab('content')} className={`flex-1 py-3 text-xs font-bold uppercase tracking-wider ${activeTab === 'content' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-400 hover:text-gray-600'}`}>Content</button>
                <button onClick={() => setActiveTab('settings')} className={`flex-1 py-3 text-xs font-bold uppercase tracking-wider ${activeTab === 'settings' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-400 hover:text-gray-600'}`}>Settings</button>
            </div>

            {/* Content Form */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-50/50">
                
                {activeTab === 'content' && (
                <>
                    {/* Header Media (For Rich Cards) */}
                    {['rich_card', 'image', 'video'].includes(local.type) && (
                        <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm space-y-3">
                             <div className="flex justify-between items-center">
                                <label className="text-xs font-bold text-gray-700 uppercase">Header Media</label>
                                {local.type === 'rich_card' && (
                                    <select 
                                        className="text-[10px] border rounded bg-gray-50 px-1 py-0.5"
                                        value={local.headerType || 'none'}
                                        onChange={e => update('headerType', e.target.value)}
                                    >
                                        <option value="none">None</option>
                                        <option value="image">Image</option>
                                        <option value="video">Video</option>
                                    </select>
                                )}
                             </div>
                             {(local.type !== 'rich_card' || (local.headerType && local.headerType !== 'none')) && (
                                 <input 
                                    className="w-full border border-gray-200 p-2.5 rounded-lg text-sm font-mono bg-gray-50 focus:bg-white transition-all outline-none focus:ring-2 focus:ring-blue-500" 
                                    value={local.mediaUrl || ''} 
                                    onChange={e => update('mediaUrl', e.target.value)} 
                                    placeholder="https://your-bucket.s3.../image.jpg" 
                                />
                             )}
                        </div>
                    )}

                    {/* Main Message Body */}
                    {['text', 'image', 'input', 'interactive_button', 'interactive_list', 'handoff', 'rich_card', 'location_request', 'pickup_location', 'destination_location', 'summary', 'datetime_picker'].includes(local.type) && (
                        <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
                            <label className="block text-xs font-bold text-gray-700 uppercase mb-2">
                                {local.type === 'summary' ? 'Summary Header Text' : local.type === 'datetime_picker' ? 'Greeting Message' : 'Message Body'}
                            </label>
                            <textarea 
                                className="w-full border border-gray-200 p-3 rounded-lg text-sm h-32 resize-none outline-none focus:ring-2 focus:ring-blue-500 bg-gray-50 focus:bg-white transition-all"
                                value={local.content || ''} 
                                onChange={e => update('content', e.target.value)} 
                                placeholder={
                                    local.type === 'pickup_location' ? "Select your pickup location below:" :
                                    local.type === 'destination_location' ? "Select your destination below:" :
                                    local.type === 'summary' ? "Here is what we captured:" :
                                    local.type === 'datetime_picker' ? "When would you like to schedule this ride?" :
                                    "Type your message here..."
                                }
                            />
                            {local.type !== 'summary' && local.type !== 'datetime_picker' && (
                                <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                                    {['{{name}}', '{{phone}}', '{{email}}'].map(tag => (
                                        <button key={tag} onClick={() => update('content', (local.content || '') + ' ' + tag)} className="text-[10px] bg-gray-100 px-2 py-1 rounded border border-gray-200 hover:bg-gray-200 transition-colors">{tag}</button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {local.type === 'summary' && (
                        <div className="bg-violet-50 p-4 rounded-xl border border-violet-100 space-y-2">
                            <label className="block text-[10px] font-bold text-violet-800 uppercase">Summary Description (Optional)</label>
                            <textarea
                                className="w-full border border-violet-200 p-2.5 rounded text-sm bg-white h-20 resize-none"
                                value={local.summaryDescription || ''}
                                onChange={e => update('summaryDescription', e.target.value)}
                                placeholder="Thanks! Please review your responses below before we continue."
                            />
                        </div>
                    )}

                    {/* Smart Scheduler V2 Config */}
                    {local.type === 'datetime_picker' && (
                        <div className="bg-gradient-to-br from-cyan-50 via-sky-50 to-indigo-50 p-4 rounded-xl border border-cyan-100 shadow-sm space-y-4">
                            <div className="flex items-start gap-3">
                                <div className="bg-white p-2 rounded-lg border border-cyan-200"><CalendarClock size={16} className="text-cyan-600"/></div>
                                <div>
                                    <h4 className="text-sm font-bold text-cyan-900">Smart Scheduler V2 · Checkpoint Architecture</h4>
                                    <p className="text-xs text-cyan-800 mt-1 leading-relaxed">
                                        Safe flow: <strong>Date → Period → Time</strong>. The bot stays on this node until all checkpoints are completed.
                                    </p>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div className="bg-white p-3 rounded-lg border border-cyan-100">
                                    <label className="text-[10px] font-bold text-gray-600 uppercase">Response Variable</label>
                                    <input
                                        className="mt-1 w-full border border-gray-200 p-2 rounded-lg text-xs font-mono bg-gray-50"
                                        value={local.variable || 'time_slot'}
                                        onChange={e => update('variable', e.target.value.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase())}
                                        placeholder="time_slot"
                                    />
                                    <p className="text-[10px] text-gray-500 mt-1">Final selected time key.</p>
                                </div>
                                <div className="bg-white p-3 rounded-lg border border-cyan-100">
                                    <label className="text-[10px] font-bold text-gray-600 uppercase">Date Window (days)</label>
                                    <input
                                        type="number"
                                        min={2}
                                        max={30}
                                        className="mt-1 w-full border border-gray-200 p-2 rounded-lg text-xs bg-gray-50"
                                        value={local.dateConfig?.daysToShow ?? 7}
                                        onChange={e => update('dateConfig', { ...(local.dateConfig || {}), daysToShow: Math.min(30, Math.max(2, Number(e.target.value) || 7)) })}
                                    />
                                    <label className="mt-2 flex items-center gap-2 text-[11px] text-gray-600">
                                        <input
                                            type="checkbox"
                                            checked={local.dateConfig?.includeToday !== false}
                                            onChange={e => update('dateConfig', { ...(local.dateConfig || {}), includeToday: e.target.checked })}
                                        />
                                        Include "Today"
                                    </label>
                                </div>
                            </div>

                            <div className="bg-white p-3 rounded-lg border border-cyan-100">
                                <div className="text-[10px] font-bold text-gray-600 uppercase mb-2">Live Checkpoint Behaviour</div>
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
                                    <div className="rounded-lg border border-gray-100 bg-cyan-50 px-2 py-1.5">
                                        <div className="font-bold text-cyan-700">Step 1 · Date</div>
                                        <div className="text-gray-600">Shows Today/Tomorrow and future dates.</div>
                                    </div>
                                    <div className="rounded-lg border border-gray-100 bg-amber-50 px-2 py-1.5">
                                        <div className="font-bold text-amber-700">Step 2 · Period</div>
                                        <div className="text-gray-600">Morning/Afternoon/Evening/Night with past periods hidden for Today.</div>
                                    </div>
                                    <div className="rounded-lg border border-gray-100 bg-indigo-50 px-2 py-1.5">
                                        <div className="font-bold text-indigo-700">Step 3 · Time</div>
                                        <div className="text-gray-600">30-minute slots filtered by period and current time.</div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ... (Keep existing code for Location Presets, Buttons, List Config etc.) ... */}
                    {/* --- SMART PRESETS FOR LOCATIONS --- */}
                    {['pickup_location', 'destination_location'].includes(local.type) && (
                        <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm space-y-4">
                            <div className="flex justify-between items-center">
                                <label className="block text-xs font-bold text-gray-800 uppercase">Smart Presets</label>
                                <span className="text-[10px] text-blue-600 font-bold bg-blue-50 px-2 py-0.5 rounded-full">One-Click Options</span>
                            </div>
                            
                            <div className="space-y-2">
                                {(local.presets || []).map((preset: LocationPreset, i: number) => (
                                    <div key={i} className="flex flex-col gap-2 bg-gray-50 p-2.5 rounded-lg border border-gray-100">
                                        <div className="flex gap-2">
                                            <input 
                                                className="flex-1 p-1.5 text-xs bg-white border border-gray-200 rounded outline-none font-bold"
                                                value={preset.title}
                                                onChange={e => {
                                                    const n = [...(local.presets || [])];
                                                    n[i].title = e.target.value;
                                                    update('presets', n);
                                                }}
                                                placeholder="Label (e.g. Airport)"
                                                maxLength={24}
                                            />
                                            <button onClick={() => {
                                                const n = local.presets.filter((_:any, idx:number) => idx !== i);
                                                update('presets', n);
                                            }} className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded"><Trash2 size={14}/></button>
                                        </div>
                                        
                                        <input 
                                            className="w-full p-1.5 text-[10px] bg-white border border-gray-200 rounded outline-none placeholder:text-gray-400"
                                            value={preset.description || ''}
                                            onChange={e => {
                                                const n = [...(local.presets || [])];
                                                n[i].description = e.target.value;
                                                update('presets', n);
                                            }}
                                            placeholder="Description (Optional)"
                                            maxLength={72} 
                                        />
                                        
                                        <div className="flex items-center gap-2">
                                            <select 
                                                className={`text-[10px] p-1 rounded border border-gray-200 ${preset.type === 'manual' ? 'bg-blue-50 text-blue-700' : 'bg-white'}`}
                                                value={preset.type}
                                                onChange={e => {
                                                    const n = [...(local.presets || [])];
                                                    n[i].type = e.target.value as 'static' | 'manual';
                                                    update('presets', n);
                                                }}
                                            >
                                                <option value="static">Fixed Coords</option>
                                                <option value="manual">Manual Pin Trigger</option>
                                            </select>
                                            
                                            {preset.type === 'static' ? (
                                                <div className="flex gap-1 flex-1">
                                                    <input 
                                                        className="w-1/2 p-1 text-[10px] bg-white border border-gray-200 rounded outline-none"
                                                        placeholder="Lat"
                                                        type="number"
                                                        step="0.000001"
                                                        value={preset.latitude || ''}
                                                        onChange={e => {
                                                            const n = [...local.presets];
                                                            n[i].latitude = parseFloat(e.target.value);
                                                            update('presets', n);
                                                        }}
                                                    />
                                                    <input 
                                                        className="w-1/2 p-1 text-[10px] bg-white border border-gray-200 rounded outline-none"
                                                        placeholder="Long"
                                                        type="number"
                                                        step="0.000001"
                                                        value={preset.longitude || ''}
                                                        onChange={e => {
                                                            const n = [...local.presets];
                                                            n[i].longitude = parseFloat(e.target.value);
                                                            update('presets', n);
                                                        }}
                                                    />
                                                </div>
                                            ) : (
                                                <div className="flex-1 flex items-center gap-1 text-[9px] text-blue-500 italic pl-1">
                                                    <LocateFixed size={10} /> 
                                                    <span>Opens Map Request</span>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                                
                                {(local.presets || []).length >= 10 && (
                                    <div className="flex items-center gap-2 text-[10px] text-amber-700 bg-amber-50 p-2 rounded border border-amber-200">
                                        <AlertTriangle size={12} />
                                        <span>Max 10 options allowed by WhatsApp</span>
                                    </div>
                                )}

                                {(local.presets || []).length < 10 && (
                                    <button 
                                        onClick={() => update('presets', [...(local.presets||[]), { id: `pre_${Date.now()}`, title: 'New Option', type: 'static' }])} 
                                        className="w-full py-2 border border-dashed border-gray-300 rounded-lg text-xs font-bold text-gray-500 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 flex items-center justify-center gap-2 transition-all"
                                    >
                                        <Plus size={12} /> Add Location Option
                                    </button>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Footer Text */}
                    {['text', 'rich_card', 'interactive_button', 'summary', 'datetime_picker'].includes(local.type) && (
                        <div>
                             <label className="block text-xs font-bold text-gray-500 uppercase mb-1.5 ml-1">Footer Text (Optional)</label>
                             <input 
                                className="w-full border border-gray-200 p-2.5 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500" 
                                value={local.footerText || ''} 
                                onChange={e => update('footerText', e.target.value)} 
                                placeholder="e.g. Reply STOP to unsubscribe"
                                maxLength={60}
                            />
                        </div>
                    )}

                    {/* Buttons Config (Rich Card & Buttons) */}
                    {['interactive_button', 'rich_card'].includes(local.type) && (
                        <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
                            <div className="flex justify-between items-center mb-3">
                                <label className="block text-xs font-bold text-gray-800 uppercase">Action Buttons</label>
                                <span className="text-[10px] text-blue-600 font-bold bg-blue-50 px-2 py-0.5 rounded-full">{local.buttons?.length || 0}/3</span>
                            </div>
                            <div className="space-y-2">
                                {(local.buttons || []).map((btn: any, i: number) => (
                                    <div key={i} className="flex gap-2 items-center">
                                        <div className="flex-1 border border-gray-200 rounded-lg overflow-hidden flex bg-gray-50">
                                            <input 
                                                className="flex-1 p-2 text-sm bg-transparent outline-none"
                                                value={btn.title} 
                                                onChange={e => {
                                                    const n = [...local.buttons]; 
                                                    n[i] = { ...n[i], title: e.target.value };
                                                    update('buttons', n);
                                                }} 
                                                placeholder="Button Label"
                                                maxLength={20}
                                            />
                                        </div>
                                        <button onClick={() => update('buttons', local.buttons.filter((_:any, idx:number) => idx !== i))} className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"><Trash2 size={16}/></button>
                                    </div>
                                ))}
                                {(local.buttons?.length || 0) < 3 && (
                                    <button 
                                        onClick={() => update('buttons', [...(local.buttons||[]), { title: 'New Button', id: `btn_${Date.now()}_${Math.random()}`, type: 'reply' }])} 
                                        className="w-full py-2.5 border border-dashed border-gray-300 rounded-lg text-xs font-bold text-gray-500 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 flex items-center justify-center gap-2 transition-all"
                                    >
                                        <Plus size={14} /> Add Quick Reply
                                    </button>
                                )}
                            </div>
                        </div>
                    )}
                    
                    {/* List Configuration */}
                    {local.type === 'interactive_list' && (
                        <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm space-y-4">
                            <div>
                                <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Menu Button Label</label>
                                <input className="w-full border border-gray-200 p-2 rounded text-sm bg-gray-50" value={local.listButtonText || ''} onChange={e => update('listButtonText', e.target.value)} placeholder="View Options" maxLength={20} />
                            </div>
                            
                             <div>
                                <label className="block text-[10px] font-bold text-gray-500 uppercase mb-2">Sections & Rows</label>
                                {(local.sections || []).map((section: ListSection, sIdx: number) => (
                                    <div key={sIdx} className="bg-gray-50 border border-gray-200 rounded-lg p-3 mb-3">
                                        <input 
                                            className="w-full font-bold text-xs bg-transparent border-b border-gray-200 pb-1 mb-2 text-gray-800 outline-none"
                                            value={section.title}
                                            onChange={e => {
                                                const newSections = [...(local.sections || [])];
                                                newSections[sIdx].title = e.target.value;
                                                update('sections', newSections);
                                            }}
                                            placeholder="Section Title"
                                        />
                                        <div className="space-y-2">
                                            {section.rows.map((row, rIdx) => (
                                                <div key={rIdx} className="flex gap-2 items-center">
                                                    <input 
                                                        className="flex-1 bg-white border border-gray-200 text-xs p-1.5 rounded focus:border-blue-300 outline-none"
                                                        value={row.title}
                                                        onChange={e => {
                                                            const newSections = [...(local.sections || [])];
                                                            newSections[sIdx].rows[rIdx].title = e.target.value;
                                                            update('sections', newSections);
                                                        }}
                                                        placeholder="Option Title"
                                                    />
                                                    <button onClick={() => {
                                                        const newSections = [...(local.sections || [])];
                                                        newSections[sIdx].rows = newSections[sIdx].rows.filter((_, i) => i !== rIdx);
                                                        update('sections', newSections);
                                                    }} className="text-gray-300 hover:text-red-500"><X size={14}/></button>
                                                </div>
                                            ))}
                                            <button 
                                                onClick={() => {
                                                    const newSections = [...(local.sections || [])];
                                                    newSections[sIdx].rows.push({ id: `row_${Date.now()}_${Math.random()}`, title: 'New Option' });
                                                    update('sections', newSections);
                                                }}
                                                className="text-[10px] text-blue-500 font-bold hover:underline flex items-center gap-1 mt-1"
                                            >
                                                <Plus size={10} /> Add Item
                                            </button>
                                        </div>
                                    </div>
                                ))}
                                <button 
                                    onClick={() => update('sections', [...(local.sections || []), { title: 'New Section', rows: [] }])}
                                    className="w-full py-2 border border-gray-300 rounded text-xs font-bold text-gray-600 hover:bg-gray-50"
                                >
                                    Add Section
                                </button>
                            </div>
                        </div>
                    )}
                </>
                )}

                {activeTab === 'settings' && (
                <>
                    <div>
                        <label className="block text-xs font-bold text-gray-500 uppercase mb-1.5">Internal Label</label>
                        <input 
                            className="w-full border border-gray-300 p-2.5 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500" 
                            value={local.label} 
                            onChange={e => update('label', e.target.value)} 
                        />
                        <p className="text-[10px] text-gray-400 mt-1">Used for identifying this node in the canvas.</p>
                    </div>

                    {local.type === 'summary' && (
                        <div className="bg-violet-50 p-4 rounded-xl border border-violet-100 space-y-3">
                            <div className="flex items-center justify-between">
                                <label className="text-[10px] font-bold text-violet-800 uppercase">Advanced Summary Builder</label>
                                <span className="text-[10px] text-violet-700 font-semibold">{(local.summaryFields || []).length} fields</span>
                            </div>

                            <div>
                                <label className="block text-[10px] font-bold text-violet-700 uppercase mb-1">Detected Variables</label>
                                <div className="flex flex-wrap gap-1.5">
                                    {detectedVariables.length === 0 && (
                                        <span className="text-[10px] text-violet-500">No variables detected yet. Configure Input/Interactive nodes first.</span>
                                    )}
                                    {detectedVariables.map(variable => (
                                        <button
                                            key={variable}
                                            onClick={() => {
                                                const existing = (local.summaryFields || []).some((f: SummaryFieldConfig) => f.variable === variable);
                                                if (existing) return;
                                                updateSummaryFields([...(local.summaryFields || []), {
                                                    id: `sum_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                                                    variable,
                                                    label: labelFromVariable(variable),
                                                    labelStyle: 'bold',
                                                    valueStyle: 'plain'
                                                }]);
                                            }}
                                            className="px-2 py-1 rounded-full border border-violet-200 bg-white text-[10px] font-mono text-violet-700 hover:bg-violet-100"
                                        >
                                            + {variable}
                                        </button>
                                    ))}
                                </div>
                                <datalist id="summary-detected-variables">
                                    {detectedVariables.map(variable => (
                                        <option key={`suggest_${variable}`} value={variable} />
                                    ))}
                                </datalist>
                            </div>

                            <div className="grid grid-cols-3 gap-2">
                                <select
                                    className="border border-violet-200 p-2 rounded text-xs"
                                    value={(local.summaryHeaderStyle || 'bold') as SummaryTextStyle}
                                    onChange={e => update('summaryHeaderStyle', e.target.value as SummaryTextStyle)}
                                >
                                    <option value="bold">Header: Bold</option>
                                    <option value="plain">Header: Plain</option>
                                    <option value="uppercase">Header: Uppercase</option>
                                    <option value="italic">Header: Italic</option>
                                    <option value="code">Header: Code</option>
                                </select>
                                <select
                                    className="border border-violet-200 p-2 rounded text-xs"
                                    value={(local.summaryDescriptionStyle || 'plain') as SummaryTextStyle}
                                    onChange={e => update('summaryDescriptionStyle', e.target.value as SummaryTextStyle)}
                                >
                                    <option value="plain">Description: Plain</option>
                                    <option value="bold">Description: Bold</option>
                                    <option value="uppercase">Description: Uppercase</option>
                                    <option value="italic">Description: Italic</option>
                                    <option value="code">Description: Code</option>
                                </select>
                                <select
                                    className="border border-violet-200 p-2 rounded text-xs"
                                    value={(local.summaryFooterStyle || 'italic') as SummaryTextStyle}
                                    onChange={e => update('summaryFooterStyle', e.target.value as SummaryTextStyle)}
                                >
                                    <option value="italic">Footer: Italic</option>
                                    <option value="plain">Footer: Plain</option>
                                    <option value="bold">Footer: Bold</option>
                                    <option value="uppercase">Footer: Uppercase</option>
                                    <option value="code">Footer: Code</option>
                                </select>
                            </div>

                            <div className="space-y-2">
                                {(local.summaryFields || []).map((field: SummaryFieldConfig, index: number) => (
                                    <div key={field.id || index} className="bg-white border border-violet-200 rounded-lg p-2.5 space-y-2">
                                        <div className="grid grid-cols-2 gap-2">
                                            <div className="space-y-1">
                                                <input
                                                    list="summary-detected-variables"
                                                    className="border border-violet-200 p-2 rounded text-xs font-mono w-full"
                                                    value={field.variable || ''}
                                                    onChange={e => {
                                                        const next = [...(local.summaryFields || [])];
                                                        next[index] = { ...next[index], variable: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase() };
                                                        updateSummaryFields(next);
                                                    }}
                                                    placeholder="variable_name"
                                                />
                                            </div>
                                            <input
                                                className="border border-violet-200 p-2 rounded text-xs"
                                                value={field.label || ''}
                                                onChange={e => {
                                                    const next = [...(local.summaryFields || [])];
                                                    next[index] = { ...next[index], label: e.target.value };
                                                    updateSummaryFields(next);
                                                }}
                                                placeholder="Customer label"
                                            />
                                        </div>
                                        <div className="grid grid-cols-2 gap-2">
                                            <input
                                                className="border border-violet-200 p-2 rounded text-xs"
                                                value={field.prefix || ''}
                                                onChange={e => {
                                                    const next = [...(local.summaryFields || [])];
                                                    next[index] = { ...next[index], prefix: e.target.value };
                                                    updateSummaryFields(next);
                                                }}
                                                placeholder="Prefix (e.g. • )"
                                            />
                                            <input
                                                className="border border-violet-200 p-2 rounded text-xs"
                                                value={field.suffix || ''}
                                                onChange={e => {
                                                    const next = [...(local.summaryFields || [])];
                                                    next[index] = { ...next[index], suffix: e.target.value };
                                                    updateSummaryFields(next);
                                                }}
                                                placeholder="Suffix (e.g. ✅)"
                                            />
                                        </div>
                                        <div className="grid grid-cols-2 gap-2">
                                            <select
                                                className="border border-violet-200 p-2 rounded text-xs"
                                                value={field.labelStyle || 'bold'}
                                                onChange={e => {
                                                    const next = [...(local.summaryFields || [])];
                                                    next[index] = { ...next[index], labelStyle: e.target.value as SummaryFieldConfig['labelStyle'] };
                                                    updateSummaryFields(next);
                                                }}
                                            >
                                                <option value="bold">Label: Bold</option>
                                                <option value="plain">Label: Plain</option>
                                                <option value="uppercase">Label: Uppercase</option>
                                            </select>
                                            <select
                                                className="border border-violet-200 p-2 rounded text-xs"
                                                value={field.valueStyle || 'plain'}
                                                onChange={e => {
                                                    const next = [...(local.summaryFields || [])];
                                                    next[index] = { ...next[index], valueStyle: e.target.value as SummaryFieldConfig['valueStyle'] };
                                                    updateSummaryFields(next);
                                                }}
                                            >
                                                <option value="plain">Value: Plain</option>
                                                <option value="bold">Value: Bold</option>
                                                <option value="italic">Value: Italic</option>
                                                <option value="code">Value: Code</option>
                                            </select>
                                        </div>
                                        <div className="flex justify-between">
                                            <button
                                                onClick={() => {
                                                    if (index === 0) return;
                                                    const next = [...(local.summaryFields || [])];
                                                    [next[index - 1], next[index]] = [next[index], next[index - 1]];
                                                    updateSummaryFields(next);
                                                }}
                                                className="text-[10px] text-violet-700"
                                            >↑ Move</button>
                                            <button
                                                onClick={() => {
                                                    const next = (local.summaryFields || []).filter((_: SummaryFieldConfig, i: number) => i !== index);
                                                    updateSummaryFields(next);
                                                }}
                                                className="text-[10px] text-red-500"
                                            >Remove</button>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            <button
                                onClick={() => updateSummaryFields([...(local.summaryFields || []), {
                                    id: `sum_${Date.now()}`,
                                    variable: '',
                                    label: '',
                                    labelStyle: 'bold',
                                    valueStyle: 'plain'
                                }])}
                                className="w-full py-2 border border-dashed border-violet-300 rounded-lg text-xs font-bold text-violet-700"
                            >
                                <Plus size={12} className="inline mr-1" /> Add Custom Summary Row
                            </button>

                            <div className="grid grid-cols-2 gap-2">
                                <label className="flex items-center gap-2 text-[11px] text-violet-800">
                                    <input
                                        type="checkbox"
                                        checked={local.summaryUseAutoVariables ?? false}
                                        onChange={e => update('summaryUseAutoVariables', e.target.checked)}
                                    />
                                    Include unconfigured variables
                                </label>
                                <input
                                    className="border border-violet-200 p-2 rounded text-xs"
                                    value={local.summaryEmptyText || ''}
                                    onChange={e => update('summaryEmptyText', e.target.value)}
                                    placeholder="No data fallback"
                                />
                            </div>
                        </div>
                    )}

                    {/* Set Variable Logic */}
                    {local.type === 'set_variable' && (
                        <div className="bg-cyan-50 p-4 rounded-xl border border-cyan-100 space-y-4">
                            <div>
                                <label className="block text-[10px] font-bold text-cyan-800 uppercase mb-1">Variable Name</label>
                                <input className="w-full border border-cyan-200 p-2 rounded text-sm bg-white" value={local.variable || ''} onChange={e => update('variable', e.target.value)} placeholder="e.g. is_qualified" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-bold text-cyan-800 uppercase mb-1">Value to Assign</label>
                                <input className="w-full border border-cyan-200 p-2 rounded text-sm bg-white" value={local.operationValue || ''} onChange={e => update('operationValue', e.target.value)} placeholder="true" />
                            </div>
                        </div>
                    )}

                    {/* Delay Logic */}
                    {local.type === 'delay' && (
                        <div className="bg-gray-100 p-4 rounded-xl border border-gray-200">
                             <label className="block text-[10px] font-bold text-gray-600 uppercase mb-1">Delay Duration (Milliseconds)</label>
                             <input type="number" className="w-full border border-gray-300 p-2 rounded text-sm bg-white" value={local.delayTime || 2000} onChange={e => update('delayTime', parseInt(e.target.value))} />
                             <p className="text-[10px] text-gray-400 mt-1">1000ms = 1 Second. Max 5000ms recommended.</p>
                        </div>
                    )}

                    {/* Input Logic */}
                    {local.type === 'input' && (
                        <div className="bg-orange-50 p-4 rounded-xl border border-orange-100 space-y-4">
                             <div>
                                <label className="block text-[10px] font-bold text-orange-800 uppercase mb-1">Save Response To</label>
                                <input className="w-full border border-orange-200 p-2 rounded text-sm bg-white" value={local.variable || ''} onChange={e => update('variable', e.target.value)} placeholder="variable_name" />
                            </div>
                            <div>
                                <label className="block text-[10px] font-bold text-orange-800 uppercase mb-1">Expected Format</label>
                                <select className="w-full border border-orange-200 p-2 rounded text-sm bg-white" value={local.validationType || 'text'} onChange={e => update('validationType', e.target.value)}>
                                    <option value="text">Text</option>
                                    <option value="email">Email</option>
                                    <option value="phone">Phone Number</option>
                                    <option value="number">Number</option>
                                    <option value="location">Live Location</option>
                                </select>
                            </div>
                        </div>
                    )}

                    {/* Condition Logic */}
                    {local.type === 'condition' && (
                         <div className="bg-amber-50 p-4 rounded-xl border border-amber-100 space-y-3">
                             <div>
                                <label className="block text-[10px] font-bold text-amber-800 uppercase mb-1">Check Variable</label>
                                <input className="w-full border border-amber-200 p-2 rounded text-sm bg-white" value={local.variable || ''} onChange={e => update('variable', e.target.value)} />
                             </div>
                             <div className="grid grid-cols-2 gap-2">
                                <select className="w-full border border-amber-200 p-2 rounded text-sm bg-white" value={local.operator || 'equals'} onChange={e => update('operator', e.target.value)}>
                                    <option value="equals">Equals</option>
                                    <option value="contains">Contains</option>
                                    <option value="is_set">Is Set</option>
                                </select>
                                <input className="w-full border border-amber-200 p-2 rounded text-sm bg-white" value={local.value || ''} onChange={e => update('value', e.target.value)} placeholder="Value" />
                             </div>
                         </div>
                    )}
                </>
                )}

            </div>
            
            {/* Footer */}
            <div className="p-4 border-t border-gray-200 bg-gray-50 flex justify-between items-center shrink-0">
                <button onClick={() => {
                     const flowStore = useFlowStore.getState();
                     flowStore.deleteNode(node.id);
                     onClose();
                }} className="text-red-600 hover:bg-red-100 hover:text-red-700 px-4 py-2 rounded-lg transition-colors flex items-center gap-2 text-xs font-bold w-full justify-center">
                    <Trash2 size={14} /> Delete Node
                </button>
            </div>
        </div>
    );
};

const nodeTypes = {
  custom: UniversalNode
};

export const BotBuilder = ({ isLiveMode }: { isLiveMode: boolean }) => {
  const { 
    nodes, edges, onNodesChange, onEdgesChange, onConnect, 
    addNode, setNodes, setEdges, updateNodeData, resetFlow 
  } = useFlowStore();

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'flow' | 'ai'>('flow');
  const [isSaving, setIsSaving] = useState(false);

  // Load Initial Data
  useEffect(() => {
    const load = async () => {
      let settings;
      if (isLiveMode) {
         try { settings = await liveApiService.getBotSettings(); } catch(e) {}
      } else {
         settings = mockBackend.getBotSettings();
      }
      
      if (settings && settings.nodes) {
          // Hydrate store
          setNodes(settings.nodes);
          setEdges(settings.edges);
      }
    };
    load();
  }, [isLiveMode]);

  const handleSave = async () => {
      setIsSaving(true);
      const settings = {
          isEnabled: true,
          shouldRepeat: false, 
          routingStrategy: 'BOT_ONLY',
          nodes,
          edges
      };

      try {
          if (isLiveMode) {
              await liveApiService.saveBotSettings(settings);
              alert("Live Bot Updated!");
          } else {
              mockBackend.updateBotSettings(settings as any);
              alert("Simulator Bot Updated!");
          }
      } catch(e) {
          alert("Save Failed");
      } finally {
          setIsSaving(false);
      }
  };

  const onNodeClick = (_: any, node: Node) => {
      setSelectedNodeId(node.id);
  };

  const handleAddNode = (type: NodeType) => {
      const id = `node_${Date.now()}`;
      const newNode: Node<FlowNodeData> = {
          id,
          type: 'custom',
          position: { x: 250, y: 100 + (nodes.length * 50) },
          data: { 
              id, 
              type, 
              label: type.replace(/_/g, ' '), 
              content: type === 'pickup_location' ? 'Select Pickup Location:' : type === 'destination_location' ? 'Select Destination:' : '',
              presets: (type === 'pickup_location' || type === 'destination_location') ? [{ id: 'pre_1', title: 'Select on Map', type: 'manual' }] : undefined 
          }
      };
      
      if (type === 'summary') {
          newNode.data.content = "📋 Booking Summary";
          newNode.data.summaryDescription = "Please review your responses below.";
          newNode.data.summaryUseAutoVariables = false;
          newNode.data.summaryEmptyText = "No responses captured yet.";
          newNode.data.footerText = "Reply YES to confirm or NO to edit.";
      }
      if (type === 'datetime_picker') {
          newNode.data.content = "When would you like to schedule this ride?";
          newNode.data.variable = 'pickup_time';
          newNode.data.dateConfig = { daysToShow: 7, includeToday: true };
      }

      addNode(newNode);
  };

  if (activeView === 'ai') {
      return (
          <div className="h-full flex flex-col">
              <div className="bg-white border-b border-gray-200 p-4 flex items-center gap-4">
                  <button onClick={() => setActiveView('flow')} className="flex items-center gap-2 text-gray-500 hover:text-gray-900 font-bold text-sm">
                      <LayoutTemplate size={18} /> Back to Flow
                  </button>
              </div>
              <AITraining isLiveMode={isLiveMode} />
          </div>
      );
  }

  return (
    <div className="flex h-full relative font-sans text-gray-900">
      {/* Sidebar / Toolbar */}
      <div className="w-64 bg-white border-r border-gray-200 flex flex-col shrink-0 z-10 shadow-sm">
         <div className="p-5 border-b border-gray-200">
             <h2 className="font-extrabold text-gray-900 text-lg flex items-center gap-2">
                 <Bot size={20} className="text-blue-600" /> Bot Studio
             </h2>
             <div className="flex gap-2 mt-4">
                 <button onClick={() => setActiveView('flow')} className={`flex-1 py-1.5 text-xs font-bold rounded-lg border ${activeView === 'flow' ? 'bg-blue-50 border-blue-200 text-blue-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>Flow</button>
                 <button onClick={() => setActiveView('ai')} className={`flex-1 py-1.5 text-xs font-bold rounded-lg border ${(activeView as string) === 'ai' ? 'bg-purple-50 border-purple-200 text-purple-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>AI Persona</button>
             </div>
         </div>
         
         <div className="flex-1 overflow-y-auto p-4 space-y-6">
             {/* Node Palette */}
             <div>
                 <h3 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-3">Add Elements</h3>
                 <div className="grid grid-cols-2 gap-2">
                     <button onClick={() => handleAddNode('text')} className="flex flex-col items-center justify-center p-3 rounded-xl border border-gray-200 bg-white hover:border-blue-400 hover:shadow-sm transition-all text-gray-600 hover:text-blue-600">
                         <Type size={20} className="mb-1" />
                         <span className="text-[10px] font-bold">Text</span>
                     </button>
                     <button onClick={() => handleAddNode('image')} className="flex flex-col items-center justify-center p-3 rounded-xl border border-gray-200 bg-white hover:border-purple-400 hover:shadow-sm transition-all text-gray-600 hover:text-purple-600">
                         <ImageIcon size={20} className="mb-1" />
                         <span className="text-[10px] font-bold">Media</span>
                     </button>
                     <button onClick={() => handleAddNode('interactive_button')} className="flex flex-col items-center justify-center p-3 rounded-xl border border-gray-200 bg-white hover:border-rose-400 hover:shadow-sm transition-all text-gray-600 hover:text-rose-600">
                         <MousePointer size={20} className="mb-1" />
                         <span className="text-[10px] font-bold">Buttons</span>
                     </button>
                     <button onClick={() => handleAddNode('interactive_list')} className="flex flex-col items-center justify-center p-3 rounded-xl border border-gray-200 bg-white hover:border-indigo-400 hover:shadow-sm transition-all text-gray-600 hover:text-indigo-600">
                         <List size={20} className="mb-1" />
                         <span className="text-[10px] font-bold">List Menu</span>
                     </button>
                 </div>
                 
                 <h3 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-3 mt-6">Logic & Data</h3>
                 <div className="grid grid-cols-2 gap-2">
                     <button onClick={() => handleAddNode('condition')} className="flex flex-col items-center justify-center p-3 rounded-xl border border-gray-200 bg-white hover:border-amber-400 hover:shadow-sm transition-all text-gray-600 hover:text-amber-600">
                         <GitBranch size={20} className="mb-1" />
                         <span className="text-[10px] font-bold">Condition</span>
                     </button>
                     <button onClick={() => handleAddNode('input')} className="flex flex-col items-center justify-center p-3 rounded-xl border border-gray-200 bg-white hover:border-orange-400 hover:shadow-sm transition-all text-gray-600 hover:text-orange-600">
                         <CornerRightDown size={20} className="mb-1" />
                         <span className="text-[10px] font-bold">Get Input</span>
                     </button>
                     <button onClick={() => handleAddNode('pickup_location')} className="flex flex-col items-center justify-center p-3 rounded-xl border border-gray-200 bg-white hover:border-lime-400 hover:shadow-sm transition-all text-gray-600 hover:text-lime-600">
                         <MapPin size={20} className="mb-1" />
                         <span className="text-[10px] font-bold">Pickup Loc</span>
                     </button>
                     <button onClick={() => handleAddNode('destination_location')} className="flex flex-col items-center justify-center p-3 rounded-xl border border-gray-200 bg-white hover:border-red-400 hover:shadow-sm transition-all text-gray-600 hover:text-red-600">
                         <Navigation size={20} className="mb-1" />
                         <span className="text-[10px] font-bold">Dest Loc</span>
                     </button>
                     <button onClick={() => handleAddNode('datetime_picker')} className="flex flex-col items-center justify-center p-3 rounded-xl border border-gray-200 bg-white hover:border-cyan-400 hover:shadow-sm transition-all text-gray-600 hover:text-cyan-600">
                         <CalendarClock size={20} className="mb-1" />
                         <span className="text-[10px] font-bold">Scheduler</span>
                     </button>
                     <button onClick={() => handleAddNode('set_variable')} className="flex flex-col items-center justify-center p-3 rounded-xl border border-gray-200 bg-white hover:border-teal-400 hover:shadow-sm transition-all text-gray-600 hover:text-teal-600">
                         <Variable size={20} className="mb-1" />
                         <span className="text-[10px] font-bold">Set Var</span>
                     </button>
                     <button onClick={() => handleAddNode('summary')} className="flex flex-col items-center justify-center p-3 rounded-xl border border-gray-200 bg-white hover:border-violet-400 hover:shadow-sm transition-all text-gray-600 hover:text-violet-600">
                         <FileCheck size={20} className="mb-1" />
                         <span className="text-[10px] font-bold">Summary</span>
                     </button>
                 </div>

                 <h3 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-3 mt-6">Advanced</h3>
                 <div className="grid grid-cols-2 gap-2">
                     <button onClick={() => handleAddNode('rich_card')} className="flex flex-col items-center justify-center p-3 rounded-xl border border-gray-200 bg-white hover:border-pink-400 hover:shadow-sm transition-all text-gray-600 hover:text-pink-600">
                         <CreditCard size={20} className="mb-1" />
                         <span className="text-[10px] font-bold">Rich Card</span>
                     </button>
                     <button onClick={() => handleAddNode('delay')} className="flex flex-col items-center justify-center p-3 rounded-xl border border-gray-200 bg-white hover:border-gray-400 hover:shadow-sm transition-all text-gray-600 hover:text-gray-800">
                         <Clock size={20} className="mb-1" />
                         <span className="text-[10px] font-bold">Delay</span>
                     </button>
                 </div>
             </div>
         </div>
         
         <div className="p-4 border-t border-gray-200 bg-gray-50">
             <button onClick={handleSave} disabled={isSaving} className="w-full bg-black text-white py-3 rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-gray-800 transition-all disabled:opacity-50">
                 {isSaving ? <RefreshCw size={18} className="animate-spin" /> : <Save size={18} />}
                 {isSaving ? 'Saving...' : 'Save Flow'}
             </button>
         </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 h-full bg-slate-50 relative">
          <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              nodeTypes={nodeTypes}
              onNodeClick={onNodeClick}
              onPaneClick={() => setSelectedNodeId(null)}
              fitView
              attributionPosition="bottom-right"
          >
              <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#cbd5e1" />
              <Controls className="!bg-white !shadow-lg !border-none !rounded-lg !m-4" />
              <MiniMap className="!bg-white !border-2 !border-gray-100 !rounded-lg !shadow-lg !bottom-4 !right-4 !w-48 !h-32" zoomable pannable />
          </ReactFlow>
      </div>

      {/* Properties Sidebar (Overlay) */}
      {selectedNodeId && nodes.find(n => n.id === selectedNodeId) && (
          <PropertiesPanel 
              node={nodes.find(n => n.id === selectedNodeId)!} 
              onChange={updateNodeData} 
              onClose={() => setSelectedNodeId(null)} 
          />
      )}
    </div>
  );
};
