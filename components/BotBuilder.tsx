
import React, { useState, useCallback, useEffect, useMemo } from 'react';
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
  Edge,
  MarkerType,
  Connection
} from '@xyflow/react';
import { useFlowStore } from '../services/flowStore';
import { liveApiService } from '../services/liveApiService';
import { mockBackend } from '../services/mockBackend';
import { 
  MessageSquare, FileText, List, GitBranch, 
  Save, Play, AlertTriangle, Trash2, 
  Check, User, HelpCircle, Phone, X, LayoutTemplate, 
  RefreshCw, Zap, Image as ImageIcon, Video, MousePointer,
  Settings, GripVertical, Plus, ChevronRight, ChevronDown, ListPlus, ShieldAlert
} from 'lucide-react';
import { FlowNodeData, NodeType, ListSection, ListRow } from '../types';

// --- 1. VISUAL NODE COMPONENTS ---

const NodeShell = ({ selected, color, icon, label, children }: any) => (
    <div className={`w-[280px] bg-white rounded-xl shadow-lg transition-all duration-200 group ${selected ? 'ring-2 ring-blue-500 shadow-xl' : 'border border-gray-200 hover:border-gray-300'}`}>
        <div className={`h-1.5 w-full rounded-t-xl ${color}`} />
        <div className="px-4 py-3 flex items-center gap-2 border-b border-gray-100">
            <div className={`p-1.5 rounded-lg ${color.replace('bg-', 'text-').replace('600', '600')} bg-opacity-10`}>
                {icon}
            </div>
            <span className="font-bold text-xs text-gray-700 uppercase tracking-wide flex-1">{label}</span>
            <GripVertical size={14} className="text-gray-300 opacity-0 group-hover:opacity-100 cursor-grab" />
        </div>
        <div className="p-4 text-sm text-gray-600 relative">
            {children}
        </div>
    </div>
);

const UniversalNode = ({ data, selected }: { data: FlowNodeData, selected: boolean }) => {
    let config = { color: 'bg-slate-600', icon: <MessageSquare size={14} />, label: 'Message' };
    
    switch(data.type) {
        case 'start': config = { color: 'bg-emerald-500', icon: <Zap size={14} />, label: 'Start Flow' }; break;
        case 'text': config = { color: 'bg-blue-500', icon: <MessageSquare size={14} />, label: 'Text Message' }; break;
        case 'image': config = { color: 'bg-purple-500', icon: <ImageIcon size={14} />, label: 'Send Media' }; break;
        case 'input': config = { color: 'bg-orange-500', icon: <HelpCircle size={14} />, label: 'Collect Data' }; break;
        case 'interactive_button': config = { color: 'bg-pink-500', icon: <MousePointer size={14} />, label: 'Buttons' }; break;
        case 'interactive_list': config = { color: 'bg-indigo-500', icon: <List size={14} />, label: 'Interactive List' }; break;
        case 'condition': config = { color: 'bg-amber-500', icon: <GitBranch size={14} />, label: 'Logic Check' }; break;
        case 'handoff': config = { color: 'bg-red-500', icon: <User size={14} />, label: 'Human Agent' }; break;
        case 'status_update': config = { color: 'bg-cyan-600', icon: <Check size={14} />, label: 'Update Status' }; break;
    }

    return (
        <NodeShell selected={selected} {...config}>
            {data.type !== 'start' && <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-gray-400 !-left-1.5" />}
            
            <div className="line-clamp-3 whitespace-pre-wrap mb-2">
                {data.content ? data.content : <span className="text-gray-400 italic">Configure this node...</span>}
            </div>

            {/* List Preview */}
            {data.type === 'interactive_list' && (
                <div className="bg-gray-50 border border-gray-200 rounded p-2 text-xs">
                    <div className="font-bold text-indigo-600 mb-1">{data.listButtonText || 'Menu'}</div>
                    <div className="space-y-1">
                        {data.sections?.slice(0, 1).map((s, i) => (
                            <div key={i}>
                                <div className="text-[10px] uppercase text-gray-400 font-bold">{s.title}</div>
                                {s.rows.slice(0, 2).map((r, j) => (
                                    <div key={j} className="pl-1 text-gray-600 flex items-center justify-between">
                                        <span>• {r.title}</span>
                                        <Handle type="source" position={Position.Right} id={r.id} className="!bg-indigo-500 !w-2 !h-2 !relative !transform-none !right-[-12px]" />
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Button Preview */}
            {data.type === 'interactive_button' && (
                <div className="mt-3 space-y-1">
                    {data.buttons?.map((btn, i) => (
                        <div key={i} className="relative">
                            <div className="bg-pink-50 text-pink-700 text-xs py-1.5 px-3 rounded text-center font-bold border border-pink-100">{btn.title}</div>
                            <Handle type="source" position={Position.Right} id={btn.id} className="!bg-pink-500 !w-2.5 !h-2.5 !-right-1.5 top-1/2" />
                        </div>
                    ))}
                </div>
            )}
            
            {/* Condition Preview */}
            {data.type === 'condition' && (
                <div className="mt-3 space-y-2">
                    <div className="flex justify-between items-center text-xs font-bold text-green-700 bg-green-50 p-1.5 rounded border border-green-100">
                        <span>True / Match</span>
                        <Handle type="source" position={Position.Right} id="true" className="!bg-green-500 !w-2.5 !h-2.5 !relative !transform-none !right-[-10px]" />
                    </div>
                    <div className="flex justify-between items-center text-xs font-bold text-red-700 bg-red-50 p-1.5 rounded border border-red-100">
                        <span>False / Else</span>
                        <Handle type="source" position={Position.Right} id="false" className="!bg-red-500 !w-2.5 !h-2.5 !relative !transform-none !right-[-10px]" />
                    </div>
                </div>
            )}

            {/* Standard Output */}
            {!['interactive_button', 'interactive_list', 'condition'].includes(data.type) && (
                <Handle type="source" position={Position.Right} className={`!w-3 !h-3 !-right-1.5 ${config.color.replace('bg-', '!bg-')}`} />
            )}
        </NodeShell>
    );
};

// --- 2. PROPERTIES PANEL (THE EDITOR) ---

const PropertiesPanel = ({ node, onChange, onClose }: { node: Node<FlowNodeData>, onChange: (id: string, d: any) => void, onClose: () => void }) => {
    const [local, setLocal] = useState(node.data);
    
    // Sync local state when node selection changes
    useEffect(() => setLocal(node.data), [node.id]);

    const update = (k: string, v: any) => {
        const n = { ...local, [k]: v };
        setLocal(n);
        onChange(node.id, n);
    };

    return (
        <div className="w-[380px] bg-white border-l border-gray-200 h-full flex flex-col shadow-2xl z-20 animate-in slide-in-from-right duration-300">
            {/* Header */}
            <div className="px-5 py-4 border-b bg-gray-50 flex justify-between items-center">
                <div>
                    <h3 className="font-bold text-gray-900 text-sm uppercase tracking-wide flex items-center gap-2">
                        <Settings size={14} />
                        {local.type.replace(/_/g, ' ')}
                    </h3>
                    <p className="text-[10px] text-gray-500 font-mono mt-0.5">ID: {node.id}</p>
                </div>
                <button onClick={onClose} className="p-1 hover:bg-gray-200 rounded transition-colors"><X size={16} /></button>
            </div>

            {/* Content Form */}
            <div className="flex-1 overflow-y-auto p-5 space-y-6">
                
                {/* 1. Internal Label */}
                <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase mb-1.5">Node Name (Internal)</label>
                    <input 
                        className="w-full border border-gray-300 p-2.5 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500 transition-shadow" 
                        value={local.label} 
                        onChange={e => update('label', e.target.value)} 
                    />
                </div>

                {/* 2. Message Body */}
                {['text', 'image', 'input', 'interactive_button', 'interactive_list', 'handoff'].includes(local.type) && (
                    <div>
                        <label className="block text-xs font-bold text-gray-500 uppercase mb-1.5">Message Text</label>
                        <textarea 
                            className="w-full border border-gray-300 p-3 rounded-lg text-sm h-32 resize-none outline-none focus:ring-2 focus:ring-blue-500 transition-shadow"
                            value={local.content || ''} 
                            onChange={e => update('content', e.target.value)} 
                            placeholder="Hello {{name}}, how can I help you today?"
                        />
                        <div className="text-[10px] text-gray-400 mt-1 flex justify-between">
                            <span>Supports Markdown & variables</span>
                        </div>
                    </div>
                )}

                {/* 3. Media Configuration */}
                {['image', 'video'].includes(local.type) && (
                    <div>
                        <label className="block text-xs font-bold text-gray-500 uppercase mb-1.5">Media URL (S3)</label>
                        <input className="w-full border border-gray-300 p-2.5 rounded-lg text-sm font-mono mb-2" value={local.mediaUrl || ''} onChange={e => update('mediaUrl', e.target.value)} placeholder="https://..." />
                        {local.mediaUrl && (
                            <div className="h-32 bg-gray-100 rounded-lg overflow-hidden border border-gray-200">
                                <img src={local.mediaUrl} className="w-full h-full object-cover" alt="Preview" onError={(e) => (e.currentTarget.style.display = 'none')} />
                            </div>
                        )}
                    </div>
                )}

                {/* 4. Input & Validation Logic */}
                {local.type === 'input' && (
                    <div className="space-y-4">
                        <div className="bg-orange-50 p-4 rounded-xl border border-orange-100 space-y-4">
                            <div className="flex items-center gap-2 text-orange-800 font-bold text-xs uppercase"><HelpCircle size={14} /> Data Collection</div>
                            
                            <div>
                                <label className="block text-[10px] font-bold text-orange-800 uppercase mb-1">Save to Variable</label>
                                <input className="w-full border border-orange-200 p-2.5 rounded-lg text-sm font-mono bg-white" value={local.variable || ''} onChange={e => update('variable', e.target.value)} placeholder="e.g. user_email" />
                            </div>
                            
                            <div>
                                <label className="block text-[10px] font-bold text-orange-800 uppercase mb-1">Validation Type</label>
                                <select className="w-full border border-orange-200 p-2.5 rounded-lg text-sm bg-white outline-none" value={local.validationType || 'text'} onChange={e => update('validationType', e.target.value)}>
                                    <option value="text">Any Text (No Validation)</option>
                                    <option value="email">Email Address</option>
                                    <option value="phone">Phone Number</option>
                                    <option value="number">Number Only</option>
                                    <option value="regex">Custom Regex</option>
                                </select>
                            </div>

                            {local.validationType === 'regex' && (
                                <div>
                                    <label className="block text-[10px] font-bold text-orange-800 uppercase mb-1">Regex Pattern</label>
                                    <input className="w-full border border-orange-200 p-2.5 rounded-lg text-sm font-mono bg-white" value={local.validationRegex || ''} onChange={e => update('validationRegex', e.target.value)} placeholder="e.g. ^[0-9]{5}$" />
                                </div>
                            )}
                        </div>

                        {local.validationType !== 'text' && (
                            <div>
                                <label className="block text-xs font-bold text-red-500 uppercase mb-1.5 flex items-center gap-1"><ShieldAlert size={12}/> Error Message (Retry)</label>
                                <textarea 
                                    className="w-full border border-red-200 bg-red-50 p-3 rounded-lg text-sm h-20 resize-none outline-none focus:ring-2 focus:ring-red-500"
                                    value={local.retryMessage || ''} 
                                    onChange={e => update('retryMessage', e.target.value)} 
                                    placeholder="That doesn't look right. Please try again."
                                />
                            </div>
                        )}
                    </div>
                )}

                {/* 5. Buttons Builder */}
                {local.type === 'interactive_button' && (
                    <div className="bg-pink-50 p-4 rounded-xl border border-pink-100">
                        <label className="block text-xs font-bold text-pink-800 uppercase mb-2">Reply Buttons (Max 3)</label>
                        <div className="space-y-2">
                            {(local.buttons || []).map((btn: any, i: number) => (
                                <div key={i} className="flex gap-2">
                                    <input 
                                        className="flex-1 border border-pink-200 p-2 rounded-lg text-sm bg-white" 
                                        value={btn.title} 
                                        onChange={e => {
                                            const n = [...local.buttons]; 
                                            n[i] = { ...n[i], title: e.target.value, id: n[i].id || `btn_${Date.now()}_${i}` };
                                            update('buttons', n);
                                        }} 
                                        placeholder="Button Label"
                                        maxLength={20}
                                    />
                                    <button onClick={() => update('buttons', local.buttons.filter((_:any, idx:number) => idx !== i))} className="p-2 text-pink-500 hover:bg-pink-100 rounded-lg"><Trash2 size={16}/></button>
                                </div>
                            ))}
                            {(local.buttons?.length || 0) < 3 && (
                                <button 
                                    onClick={() => update('buttons', [...(local.buttons||[]), { title: 'New Option', id: 'btn_' + Date.now() + Math.random(), type: 'reply' }])} 
                                    className="w-full py-2 border-2 border-dashed border-pink-200 rounded-lg text-xs font-bold text-pink-500 hover:bg-pink-100 transition-colors flex items-center justify-center gap-1"
                                >
                                    <Plus size={14} /> Add Button
                                </button>
                            )}
                        </div>
                    </div>
                )}

                {/* 6. List Builder (Advanced) */}
                {local.type === 'interactive_list' && (
                    <div className="bg-indigo-50 p-4 rounded-xl border border-indigo-100 space-y-4">
                        <div className="flex items-center gap-2 text-indigo-800 font-bold text-xs uppercase"><List size={14} /> List Configuration</div>
                        
                        <div>
                            <label className="block text-[10px] font-bold text-indigo-800 uppercase mb-1">Menu Button Text</label>
                            <input className="w-full border border-indigo-200 p-2 rounded text-sm bg-white" value={local.listButtonText || ''} onChange={e => update('listButtonText', e.target.value)} placeholder="Open Menu" maxLength={20} />
                        </div>

                        <div>
                            <label className="block text-[10px] font-bold text-indigo-800 uppercase mb-2">Sections & Rows</label>
                            {(local.sections || []).map((section: ListSection, sIdx: number) => (
                                <div key={sIdx} className="bg-white border border-indigo-200 rounded-lg p-3 mb-3">
                                    <div className="flex gap-2 mb-2">
                                        <input 
                                            className="flex-1 font-bold text-xs border-b border-gray-200 outline-none pb-1"
                                            value={section.title}
                                            onChange={e => {
                                                const newSections = [...(local.sections || [])];
                                                newSections[sIdx].title = e.target.value;
                                                update('sections', newSections);
                                            }}
                                            placeholder="Section Title"
                                        />
                                        <button onClick={() => update('sections', local.sections.filter((_:any, i:number) => i !== sIdx))} className="text-red-400 hover:text-red-600"><Trash2 size={12}/></button>
                                    </div>
                                    <div className="space-y-2 pl-2 border-l-2 border-indigo-100">
                                        {section.rows.map((row, rIdx) => (
                                            <div key={rIdx} className="flex gap-2 items-center">
                                                <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full"></div>
                                                <input 
                                                    className="flex-1 bg-gray-50 border border-gray-100 text-xs p-1.5 rounded"
                                                    value={row.title}
                                                    onChange={e => {
                                                        const newSections = [...(local.sections || [])];
                                                        newSections[sIdx].rows[rIdx].title = e.target.value;
                                                        // Ensure ID exists
                                                        if (!newSections[sIdx].rows[rIdx].id) newSections[sIdx].rows[rIdx].id = `row_${Date.now()}_${rIdx}`;
                                                        update('sections', newSections);
                                                    }}
                                                    placeholder="Option Title"
                                                />
                                                <button onClick={() => {
                                                    const newSections = [...(local.sections || [])];
                                                    newSections[sIdx].rows = newSections[sIdx].rows.filter((_, i) => i !== rIdx);
                                                    update('sections', newSections);
                                                }} className="text-gray-400 hover:text-red-500"><X size={12}/></button>
                                            </div>
                                        ))}
                                        <button 
                                            onClick={() => {
                                                const newSections = [...(local.sections || [])];
                                                newSections[sIdx].rows.push({ id: `row_${Date.now()}`, title: 'New Option' });
                                                update('sections', newSections);
                                            }}
                                            className="text-[10px] text-indigo-500 font-bold hover:underline flex items-center gap-1"
                                        >
                                            <Plus size={10} /> Add Option
                                        </button>
                                    </div>
                                </div>
                            ))}
                            <button 
                                onClick={() => update('sections', [...(local.sections || []), { title: 'New Section', rows: [] }])}
                                className="w-full py-2 border border-indigo-200 bg-white rounded text-xs font-bold text-indigo-600 hover:bg-indigo-50 flex items-center justify-center gap-1"
                            >
                                <ListPlus size={12} /> Add Section
                            </button>
                        </div>
                    </div>
                )}

                {/* 7. Logic Branching */}
                {local.type === 'condition' && (
                    <div className="bg-amber-50 p-4 rounded-xl border border-amber-100 space-y-4">
                        <div className="flex items-center gap-2 text-amber-800 font-bold text-xs uppercase"><GitBranch size={14} /> Logic Rule</div>
                        <div>
                            <label className="block text-[10px] font-bold text-amber-800 uppercase mb-1">If Variable...</label>
                            <input className="w-full border border-amber-200 p-2 rounded text-sm bg-white font-mono" value={local.variable || ''} onChange={e => update('variable', e.target.value)} placeholder="e.g. user_score" />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <div>
                                <label className="block text-[10px] font-bold text-amber-800 uppercase mb-1">Operator</label>
                                <select className="w-full border border-amber-200 p-2 rounded text-sm bg-white" value={local.operator || 'equals'} onChange={e => update('operator', e.target.value)}>
                                    <option value="equals">Equals (==)</option>
                                    <option value="contains">Contains</option>
                                    <option value="starts_with">Starts With</option>
                                    <option value="greater_than">Greater Than (&gt;)</option>
                                    <option value="less_than">Less Than (&lt;)</option>
                                    <option value="is_set">Is Set (Exists)</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-[10px] font-bold text-amber-800 uppercase mb-1">Value</label>
                                <input className="w-full border border-amber-200 p-2 rounded text-sm bg-white" value={local.value || ''} onChange={e => update('value', e.target.value)} placeholder="Target Value" />
                            </div>
                        </div>
                    </div>
                )}

            </div>
            
            {/* Footer */}
            <div className="p-4 border-t border-gray-200 bg-gray-50">
                <button onClick={() => {
                     const flowStore = useFlowStore.getState();
                     flowStore.deleteNode(node.id);
                     onClose();
                }} className="w-full py-2.5 text-red-600 font-bold text-xs uppercase hover:bg-red-100 rounded-lg transition-colors flex items-center justify-center gap-2">
                    <Trash2 size={16} /> Delete Node
                </button>
            </div>
        </div>
    );
};

// --- 3. MAIN BUILDER CANVAS ---

export const BotBuilder = ({ isLiveMode }: { isLiveMode: boolean }) => {
    const { nodes, edges, onNodesChange, onEdgesChange, onConnect, addNode, updateNodeData, setNodes, setEdges } = useFlowStore();
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [isSimulating, setIsSimulating] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        const load = async () => {
             try {
                const data = isLiveMode ? await liveApiService.getBotSettings() : mockBackend.getBotSettings();
                if (data?.nodes) {
                    setNodes(data.nodes);
                    setEdges(data.edges);
                }
             } catch(e) { console.error("Failed to load bot settings", e); }
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
        
        const position = { x: event.clientX - 300, y: event.clientY - 100 };
        
        const newNode: Node<FlowNodeData> = {
            id: `node_${Date.now()}`,
            type: 'custom',
            position,
            data: { 
                id: `node_${Date.now()}`, 
                type, 
                label, 
                content: '',
                buttons: type === 'interactive_button' ? [{ id: 'btn_1', title: 'Yes', type: 'reply'}, { id: 'btn_2', title: 'No', type: 'reply'}] : undefined,
                sections: type === 'interactive_list' ? [{ title: 'Section 1', rows: [{id: 'opt1', title: 'Option 1'}] }] : undefined
            }
        };
        addNode(newNode);
        setSelectedNodeId(newNode.id);
    };

    const handleSave = async (publish = false) => {
        setIsSaving(true);
        // Validation check
        const invalidNode = nodes.find(n => 
            (['text', 'input'].includes(n.data.type) && !n.data.content) || 
            (n.data.type === 'interactive_button' && (!n.data.buttons || n.data.buttons.length === 0))
        );

        if (invalidNode) {
            alert(`Error: Node "${invalidNode.data.label}" has empty content. Please fill it before saving.`);
            setIsSaving(false);
            setSelectedNodeId(invalidNode.id);
            return;
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
            alert(publish ? "Bot Published to Live Environment!" : "Draft Saved Successfully.");
        } catch(e) { alert("Error saving bot flow."); }
        finally { setIsSaving(false); }
    };

    const selectedNode = useMemo(() => nodes.find(n => n.id === selectedNodeId), [selectedNodeId, nodes]);

    // Tool Palette Definition
    const tools = [
        { category: "Send Message", items: [
            { type: 'text', label: 'Text', icon: <MessageSquare size={16} />, color: 'text-blue-600' },
            { type: 'image', label: 'Image/Video', icon: <ImageIcon size={16} />, color: 'text-purple-600' },
            { type: 'interactive_button', label: 'Buttons', icon: <MousePointer size={16} />, color: 'text-pink-600' },
            { type: 'interactive_list', label: 'List Menu', icon: <List size={16} />, color: 'text-indigo-600' },
        ]},
        { category: "Collect & Logic", items: [
            { type: 'input', label: 'Collect Data', icon: <HelpCircle size={16} />, color: 'text-orange-600' },
            { type: 'condition', label: 'Logic Branch', icon: <GitBranch size={16} />, color: 'text-amber-600' },
            { type: 'handoff', label: 'Human Agent', icon: <User size={16} />, color: 'text-red-600' },
            { type: 'status_update', label: 'Set Status', icon: <Check size={16} />, color: 'text-cyan-600' },
        ]}
    ];

    return (
        <div className="flex h-screen w-full bg-slate-50 overflow-hidden font-sans">
            {/* 1. Sidebar Palette */}
            <div className="w-64 bg-white border-r border-gray-200 flex flex-col shrink-0 z-10 shadow-sm">
                <div className="p-5 border-b border-gray-100 bg-white">
                    <h2 className="font-bold text-gray-900 flex items-center gap-2"><LayoutTemplate size={20} className="text-blue-600" /> Bot Studio</h2>
                    <p className="text-xs text-gray-500 mt-1">Drag nodes to canvas</p>
                </div>
                <div className="p-4 space-y-6 overflow-y-auto flex-1 bg-gray-50/50">
                    {tools.map((cat, i) => (
                        <div key={i}>
                            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">{cat.category}</div>
                            <div className="space-y-2">
                                {cat.items.map((t) => (
                                    <div 
                                        key={t.type}
                                        draggable 
                                        onDragStart={(e) => onDragStart(e, t.type as NodeType, t.label)} 
                                        className="group p-3 bg-white border border-gray-200 rounded-xl shadow-sm cursor-grab hover:border-blue-400 hover:shadow-md transition-all flex items-center gap-3 active:scale-95"
                                    >
                                        <div className={`p-2 rounded-lg bg-gray-50 group-hover:bg-blue-50 transition-colors ${t.color}`}>{t.icon}</div>
                                        <span className="text-sm font-semibold text-gray-700 group-hover:text-blue-700">{t.label}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* 2. Main Canvas */}
            <div className="flex-1 relative h-full flex flex-col">
                {/* Toolbar */}
                <div className="absolute top-5 right-5 z-20 flex gap-3">
                    <button onClick={() => setIsSimulating(!isSimulating)} className={`px-5 py-2.5 rounded-full font-bold shadow-lg transition-all flex items-center gap-2 border ${isSimulating ? 'bg-amber-500 text-white border-amber-600' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}>
                        {isSimulating ? <RefreshCw size={18} className="animate-spin" /> : <Play size={18} />} Test Run
                    </button>
                    <button onClick={() => handleSave(false)} className="px-5 py-2.5 bg-white text-gray-700 rounded-full font-bold shadow-lg border border-gray-200 hover:bg-gray-50 flex items-center gap-2">
                        <Save size={18} /> Save Draft
                    </button>
                    <button onClick={() => handleSave(true)} disabled={isSaving} className="px-5 py-2.5 bg-black text-white rounded-full font-bold shadow-lg hover:bg-gray-800 flex items-center gap-2">
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
                        <Background color="#94a3b8" gap={20} variant={BackgroundVariant.Dots} size={1} />
                        <Controls className="bg-white shadow-xl border border-gray-100 rounded-lg p-1" />
                        <MiniMap className="border border-gray-200 shadow-lg rounded-lg" nodeColor="#64748b" />
                    </ReactFlow>
                </div>
            </div>

            {/* 3. Properties Panel */}
            {selectedNode && !isSimulating && <PropertiesPanel node={selectedNode} onChange={updateNodeData} onClose={() => setSelectedNodeId(null)} />}

            {/* 4. Simulator */}
            {isSimulating && (
                <div className="absolute inset-y-0 right-0 w-96 bg-white border-l shadow-2xl z-50 flex flex-col animate-in slide-in-from-right duration-300">
                    <div className="p-4 bg-gray-900 text-white flex justify-between items-center shrink-0">
                        <div className="font-bold flex items-center gap-2"><Phone size={18} /> Bot Simulator</div>
                        <button onClick={() => setIsSimulating(false)} className="hover:bg-gray-700 p-1 rounded"><X size={20} /></button>
                    </div>
                    <div className="flex-1 bg-[#efe7dd] p-4 overflow-y-auto space-y-4">
                        <div className="text-center text-xs text-gray-500 bg-[#e1f2fb] py-1 rounded-lg border border-[#ccebf8] shadow-sm text-shadow-sm mb-6">🔒 Messages are end-to-end encrypted</div>
                        <div className="flex justify-start"><div className="bg-white p-3 rounded-lg rounded-tl-none shadow-sm text-sm max-w-[85%] text-gray-800">Hello! I'm the Uber Fleet Recruiter bot.</div></div>
                    </div>
                    <div className="p-3 bg-gray-50 border-t shrink-0">
                        <input className="w-full border rounded-full px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-green-500" placeholder="Type a message..." disabled />
                    </div>
                </div>
            )}
        </div>
    );
};
