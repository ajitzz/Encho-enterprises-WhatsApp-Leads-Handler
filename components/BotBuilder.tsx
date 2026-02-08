
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
import { useFlowStore } from '../services/flowStore';
import { liveApiService } from '../services/liveApiService';
import { mockBackend } from '../services/mockBackend';
import { 
  MessageSquare, List, GitBranch, Save, Play, Trash2, X, Zap, 
  Image as ImageIcon, MousePointer, Settings, GripVertical, Plus, 
  ListPlus, LayoutTemplate, RefreshCw, User, Check, Clock, MapPin, 
  CreditCard, FileText, Type, Variable, CornerRightDown, Navigation
} from 'lucide-react';
import { FlowNodeData, NodeType, ListSection } from '../types';

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
                {data.type !== 'delay' && data.type !== 'set_variable' && (
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
                
                {(data.type === 'pickup_location' || data.type === 'destination_location') && (
                    <div className={`flex items-center justify-center gap-2 py-2 rounded-lg border text-xs font-bold font-mono uppercase tracking-wide ${data.type === 'pickup_location' ? 'bg-lime-50 text-lime-700 border-lime-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
                        {data.type === 'pickup_location' ? <MapPin size={12}/> : <Navigation size={12}/>}
                        {data.type === 'pickup_location' ? 'Saves to: pickup_coords' : 'Saves to: dest_coords'}
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
    
    useEffect(() => setLocal(node.data), [node.id]);

    const update = (k: string, v: any) => {
        const n = { ...local, [k]: v };
        setLocal(n);
        onChange(node.id, n);
    };

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
                    {['text', 'image', 'input', 'interactive_button', 'interactive_list', 'handoff', 'rich_card', 'location_request', 'pickup_location', 'destination_location'].includes(local.type) && (
                        <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
                            <label className="block text-xs font-bold text-gray-700 uppercase mb-2">Message Body</label>
                            <textarea 
                                className="w-full border border-gray-200 p-3 rounded-lg text-sm h-32 resize-none outline-none focus:ring-2 focus:ring-blue-500 bg-gray-50 focus:bg-white transition-all"
                                value={local.content || ''} 
                                onChange={e => update('content', e.target.value)} 
                                placeholder={
                                    local.type === 'pickup_location' ? "e.g. Please share your Pickup Location:" :
                                    local.type === 'destination_location' ? "e.g. Please share your Destination:" :
                                    "Type your message here..."
                                }
                            />
                            <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                                {['{{name}}', '{{phone}}', '{{email}}'].map(tag => (
                                    <button key={tag} onClick={() => update('content', (local.content || '') + ' ' + tag)} className="text-[10px] bg-gray-100 px-2 py-1 rounded border border-gray-200 hover:bg-gray-200 transition-colors">{tag}</button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Footer Text */}
                    {['text', 'rich_card', 'interactive_button'].includes(local.type) && (
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

// --- 3. MAIN BUILDER CANVAS ---

const initialNodes: Node<FlowNodeData>[] = [
    { id: 'start', type: 'custom', position: { x: 100, y: 100 }, data: { id: 'start', type: 'start', label: 'Start Flow', content: 'Entry Point' }, deletable: false }
];

export const BotBuilder = ({ isLiveMode }: { isLiveMode: boolean }) => {
    const { nodes, edges, onNodesChange, onEdgesChange, onConnect, addNode, updateNodeData, setNodes, setEdges } = useFlowStore();
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        const load = async () => {
             try {
                const data = isLiveMode ? await liveApiService.getBotSettings() : mockBackend.getBotSettings();
                if (data?.nodes && data.nodes.length > 0) {
                    setNodes(data.nodes);
                    setEdges(data.edges);
                } else {
                    setNodes(initialNodes);
                    setEdges([]);
                }
             } catch(e) { 
                 console.error("Failed to load settings");
                 setNodes(initialNodes);
             }
        };
        load();
    }, [isLiveMode, setNodes, setEdges]);

    const onDragStart = (event: React.DragEvent, nodeType: NodeType, label: string) => {
        event.dataTransfer.setData('application/reactflow/type', nodeType);
        event.dataTransfer.setData('application/reactflow/label', label);
        event.dataTransfer.effectAllowed = 'move';
    };

    const onDrop = (event: React.DragEvent) => {
        event.preventDefault();
        const type = event.dataTransfer.getData('application/reactflow/type') as NodeType;
        const label = event.dataTransfer.getData('application/reactflow/label');
        
        const reactFlowBounds = document.querySelector('.react-flow')?.getBoundingClientRect();
        if (!reactFlowBounds) return;

        const position = { 
            x: event.clientX - reactFlowBounds.left - 100, 
            y: event.clientY - reactFlowBounds.top 
        };
        
        const newNode: Node<FlowNodeData> = {
            id: `node_${Date.now()}`,
            type: 'custom',
            position,
            data: { 
                id: `node_${Date.now()}`, 
                type, 
                label, 
                content: type === 'pickup_location' ? 'Please share your Pickup Location:' : type === 'destination_location' ? 'Please share your Destination:' : '',
                buttons: (type === 'interactive_button' || type === 'rich_card') ? [{ id: `btn_${Date.now()}_1`, title: 'Yes', type: 'reply'}, { id: `btn_${Date.now()}_2`, title: 'No', type: 'reply'}] : undefined,
                sections: type === 'interactive_list' ? [{ title: 'Main Menu', rows: [{id: `row_${Date.now()}_1`, title: 'Option 1'}] }] : undefined
            }
        };
        addNode(newNode);
        setSelectedNodeId(newNode.id);
    };

    const handleSave = async (publish = false) => {
        setIsSaving(true);
        // Validations
        if (!nodes.find(n => n.type === 'start' || n.data.type === 'start')) {
            alert("Error: Flow must have a Start Node.");
            setIsSaving(false); return;
        }
        
        const payload = { nodes, edges };
        try {
            let currentSettings = isLiveMode ? await liveApiService.getBotSettings() : mockBackend.getBotSettings();
            const newSettings = { ...currentSettings, ...payload };

            if (isLiveMode) {
                await liveApiService.saveBotSettings(newSettings);
                if (publish) await liveApiService.publishBot();
            } else {
                mockBackend.updateBotSettings(newSettings);
            }
            alert(publish ? "Bot Published Successfully!" : "Draft Saved.");
        } catch(e) { alert("Error saving flow."); }
        finally { setIsSaving(false); }
    };

    const selectedNode = useMemo(() => nodes.find(n => n.id === selectedNodeId), [selectedNodeId, nodes]);

    // Enhanced Palette
    const tools = [
        { category: "Sending", items: [
            { type: 'text', label: 'Text', icon: <Type size={16} />, color: 'text-blue-600 bg-blue-50' },
            { type: 'image', label: 'Media', icon: <ImageIcon size={16} />, color: 'text-purple-600 bg-purple-50' },
            { type: 'rich_card', label: 'Rich Card', icon: <CreditCard size={16} />, color: 'text-pink-600 bg-pink-50' },
        ]},
        { category: "Interactive", items: [
            { type: 'interactive_button', label: 'Buttons', icon: <MousePointer size={16} />, color: 'text-rose-600 bg-rose-50' },
            { type: 'interactive_list', label: 'List Menu', icon: <List size={16} />, color: 'text-indigo-600 bg-indigo-50' },
            { type: 'pickup_location', label: 'Pickup', icon: <MapPin size={16} />, color: 'text-lime-600 bg-lime-50' },
            { type: 'destination_location', label: 'Destination', icon: <Navigation size={16} />, color: 'text-red-600 bg-red-50' },
        ]},
        { category: "Logic & Flow", items: [
            { type: 'input', label: 'Collect Input', icon: <CornerRightDown size={16} />, color: 'text-orange-600 bg-orange-50' },
            { type: 'condition', label: 'Branching', icon: <GitBranch size={16} />, color: 'text-amber-600 bg-amber-50' },
            { type: 'set_variable', label: 'Set Variable', icon: <Variable size={16} />, color: 'text-cyan-600 bg-cyan-50' },
            { type: 'delay', label: 'Smart Delay', icon: <Clock size={16} />, color: 'text-gray-600 bg-gray-100' },
            { type: 'handoff', label: 'Agent Handoff', icon: <User size={16} />, color: 'text-red-600 bg-red-50' },
        ]}
    ];

    return (
        <div className="flex h-screen w-full bg-slate-100 overflow-hidden font-sans">
            {/* 1. Sidebar Palette */}
            <div className="w-64 bg-white border-r border-gray-200 flex flex-col shrink-0 z-10 shadow-sm">
                <div className="p-5 border-b border-gray-100 bg-white">
                    <h2 className="font-extrabold text-gray-900 flex items-center gap-2"><LayoutTemplate size={20} className="text-blue-600" /> Bot Studio</h2>
                    <p className="text-[10px] text-gray-400 mt-1 uppercase tracking-wider font-bold">Pro Flow Builder</p>
                </div>
                <div className="p-4 space-y-8 overflow-y-auto flex-1 bg-white scrollbar-hide">
                    {tools.map((cat, i) => (
                        <div key={i}>
                            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-3 px-1">{cat.category}</div>
                            <div className="grid grid-cols-2 gap-2">
                                {cat.items.map((t) => (
                                    <div 
                                        key={t.type}
                                        draggable 
                                        onDragStart={(e) => onDragStart(e, t.type as NodeType, t.label)} 
                                        className="group p-3 bg-white border border-gray-100 rounded-xl shadow-sm cursor-grab hover:border-blue-400 hover:shadow-md transition-all flex flex-col items-center gap-2 active:scale-95"
                                    >
                                        <div className={`p-2 rounded-lg transition-colors ${t.color}`}>{t.icon}</div>
                                        <span className="text-[10px] font-bold text-gray-600 group-hover:text-blue-700 text-center leading-tight">{t.label}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* 2. Main Canvas */}
            <div className="flex-1 relative h-full flex flex-col">
                <div className="absolute top-5 right-5 z-20 flex gap-3">
                    <button onClick={() => handleSave(false)} className="px-5 py-2.5 bg-white text-gray-700 rounded-xl font-bold shadow-lg border border-gray-100 hover:bg-gray-50 flex items-center gap-2 transition-transform active:scale-95">
                        <Save size={18} /> Save Draft
                    </button>
                    <button onClick={() => handleSave(true)} disabled={isSaving} className="px-5 py-2.5 bg-black text-white rounded-xl font-bold shadow-xl hover:bg-gray-800 flex items-center gap-2 transition-transform active:scale-95">
                        {isSaving ? <RefreshCw size={18} className="animate-spin" /> : <Zap size={18} />} Publish Live
                    </button>
                </div>

                <div className="flex-1 w-full h-full" onDrop={onDrop} onDragOver={e => e.preventDefault()}>
                    <ReactFlow
                        nodes={nodes}
                        edges={edges}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onConnect={onConnect}
                        nodeTypes={{ custom: UniversalNode }}
                        onNodeClick={(_, n) => setSelectedNodeId(n.id)}
                        onPaneClick={() => setSelectedNodeId(null)}
                        fitView
                        snapToGrid={true}
                        snapGrid={[20, 20]}
                        proOptions={{ hideAttribution: true }}
                    >
                        <Background color="#cbd5e1" gap={24} variant={BackgroundVariant.Dots} size={1.5} />
                        <Controls className="bg-white shadow-xl border border-gray-100 rounded-lg p-1" />
                        <MiniMap className="border border-gray-200 shadow-lg rounded-lg" nodeColor="#94a3b8" />
                    </ReactFlow>
                </div>
            </div>

            {/* 3. Properties Panel */}
            {selectedNode && <PropertiesPanel node={selectedNode} onChange={updateNodeData} onClose={() => setSelectedNodeId(null)} />}
        </div>
    );
};
