
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
  Connection,
  useNodesState,
  useEdgesState,
  Panel
} from '@xyflow/react';
import { useFlowStore } from '../services/flowStore';
import { liveApiService } from '../services/liveApiService';
import { mockBackend } from '../services/mockBackend';
import { 
  MessageSquare, FileText, List, GitBranch, 
  Save, Play, AlertTriangle, Trash2, 
  Check, User, HelpCircle, Phone, X, LayoutTemplate, 
  RefreshCw, Zap, Image as ImageIcon, Video, MousePointer,
  Settings, GripVertical, Plus, ChevronRight, ChevronDown, ListPlus, ShieldAlert,
  ArrowRight
} from 'lucide-react';
import { FlowNodeData, NodeType, ListSection, ListRow } from '../types';

// --- 1. ADVANCED NODE COMPONENTS ---

const NodeHeader = ({ color, icon, label, selected }: any) => (
    <div className={`px-3 py-2 flex items-center gap-2 border-b border-gray-100 rounded-t-xl ${selected ? 'bg-blue-50' : 'bg-white'}`}>
        <div className={`p-1.5 rounded-md ${color} text-white shadow-sm`}>
            {icon}
        </div>
        <span className="font-bold text-xs text-gray-800 uppercase tracking-wide flex-1">{label}</span>
        <GripVertical size={14} className="text-gray-300 opacity-0 group-hover:opacity-100 cursor-grab" />
    </div>
);

const UniversalNode = ({ data, selected, id }: { data: FlowNodeData, selected: boolean, id: string }) => {
    let config = { color: 'bg-slate-600', icon: <MessageSquare size={12} />, label: 'Message' };
    
    switch(data.type) {
        case 'start': config = { color: 'bg-emerald-500', icon: <Zap size={12} />, label: 'Start Flow' }; break;
        case 'text': config = { color: 'bg-blue-500', icon: <MessageSquare size={12} />, label: 'Text Message' }; break;
        case 'image': config = { color: 'bg-purple-500', icon: <ImageIcon size={12} />, label: 'Media' }; break;
        case 'input': config = { color: 'bg-orange-500', icon: <HelpCircle size={12} />, label: 'Collect Input' }; break;
        case 'interactive_button': config = { color: 'bg-pink-500', icon: <MousePointer size={12} />, label: 'Buttons' }; break;
        case 'interactive_list': config = { color: 'bg-indigo-500', icon: <List size={12} />, label: 'List Menu' }; break;
        case 'condition': config = { color: 'bg-amber-500', icon: <GitBranch size={12} />, label: 'Logic Check' }; break;
        case 'handoff': config = { color: 'bg-red-500', icon: <User size={12} />, label: 'Agent Handoff' }; break;
        case 'status_update': config = { color: 'bg-cyan-600', icon: <Check size={12} />, label: 'Set Status' }; break;
    }

    return (
        <div className={`w-[260px] bg-white rounded-xl shadow-lg transition-all duration-200 group border-2 ${selected ? 'border-blue-500 shadow-xl' : 'border-transparent hover:border-gray-200'}`}>
            <NodeHeader {...config} selected={selected} />
            
            <div className="p-3 text-sm text-gray-600 relative bg-white rounded-b-xl">
                {/* Input Handle */}
                {data.type !== 'start' && (
                    <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-slate-400 !border-2 !border-white !-left-[18px]" />
                )}

                {/* Content Preview */}
                <div className="text-xs mb-2">
                    {data.content ? (
                        <div className="line-clamp-3 whitespace-pre-wrap">{data.content}</div>
                    ) : (
                        <span className="text-gray-300 italic">Configure content...</span>
                    )}
                </div>

                {/* Media Preview */}
                {data.mediaUrl && (
                    <div className="mb-2 rounded-lg overflow-hidden h-20 bg-gray-50 border border-gray-100 flex items-center justify-center">
                        <img src={data.mediaUrl} className="h-full w-full object-cover opacity-80" alt="media" onError={(e) => e.currentTarget.style.display = 'none'} />
                    </div>
                )}

                {/* DYNAMIC HANDLES: List & Buttons */}
                {data.type === 'interactive_list' && (
                    <div className="space-y-1 mt-2 border-t border-gray-100 pt-2">
                        <div className="text-[9px] font-bold text-gray-400 uppercase">{data.listButtonText || 'Menu Options'}</div>
                        {data.sections?.map((section, sIdx) => (
                            <div key={sIdx}>
                                {section.rows.map((row) => (
                                    <div key={row.id} className="relative flex items-center justify-between bg-gray-50 px-2 py-1.5 rounded border border-gray-100 mb-1">
                                        <span className="text-[10px] font-medium text-gray-700 truncate pr-2">{row.title}</span>
                                        <Handle 
                                            type="source" 
                                            position={Position.Right} 
                                            id={row.id} 
                                            className="!w-2.5 !h-2.5 !bg-indigo-500 !border-2 !border-white !-right-[18px]" 
                                        />
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>
                )}

                {data.type === 'interactive_button' && (
                    <div className="flex flex-col gap-1.5 mt-2">
                        {data.buttons?.map((btn) => (
                            <div key={btn.id} className="relative bg-pink-50 text-pink-700 text-xs py-1.5 px-3 rounded text-center font-bold border border-pink-100">
                                {btn.title}
                                <Handle 
                                    type="source" 
                                    position={Position.Right} 
                                    id={btn.id} 
                                    className="!bg-pink-500 !w-2.5 !h-2.5 !border-2 !border-white !-right-[18px] top-1/2 !transform-none !-mt-1.5" 
                                />
                            </div>
                        ))}
                    </div>
                )}

                {/* DYNAMIC HANDLES: Logic */}
                {data.type === 'condition' && (
                    <div className="mt-2 space-y-2">
                        <div className="relative flex justify-between items-center text-[10px] font-bold text-green-700 bg-green-50 p-1.5 rounded border border-green-100">
                            <span>TRUE (Match)</span>
                            <Handle type="source" position={Position.Right} id="true" className="!bg-green-500 !w-2.5 !h-2.5 !border-2 !border-white !-right-[18px]" />
                        </div>
                        <div className="relative flex justify-between items-center text-[10px] font-bold text-red-700 bg-red-50 p-1.5 rounded border border-red-100">
                            <span>FALSE (Else)</span>
                            <Handle type="source" position={Position.Right} id="false" className="!bg-red-500 !w-2.5 !h-2.5 !border-2 !border-white !-right-[18px]" />
                        </div>
                    </div>
                )}

                {/* STANDARD OUTPUT HANDLE (Default) */}
                {!['interactive_button', 'interactive_list', 'condition'].includes(data.type) && (
                    <Handle 
                        type="source" 
                        position={Position.Right} 
                        className={`!w-3 !h-3 !border-2 !border-white !-right-[18px] ${config.color.replace('bg-', '!bg-')}`} 
                    />
                )}
            </div>
        </div>
    );
};

// --- 2. PROPERTIES PANEL (THE EDITOR) ---

const PropertiesPanel = ({ node, onChange, onClose }: { node: Node<FlowNodeData>, onChange: (id: string, d: any) => void, onClose: () => void }) => {
    const [local, setLocal] = useState(node.data);
    
    useEffect(() => setLocal(node.data), [node.id]);

    const update = (k: string, v: any) => {
        const n = { ...local, [k]: v };
        setLocal(n);
        onChange(node.id, n);
    };

    return (
        <div className="w-[400px] bg-white border-l border-gray-200 h-full flex flex-col shadow-2xl z-30 animate-in slide-in-from-right duration-300 absolute right-0 top-0 bottom-0">
            {/* Header */}
            <div className="px-5 py-4 border-b bg-gray-50 flex justify-between items-center shrink-0">
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
                
                <div>
                    <label className="block text-xs font-bold text-gray-500 uppercase mb-1.5">Internal Label</label>
                    <input 
                        className="w-full border border-gray-300 p-2.5 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500" 
                        value={local.label} 
                        onChange={e => update('label', e.target.value)} 
                    />
                </div>

                {/* Message Content */}
                {['text', 'image', 'input', 'interactive_button', 'interactive_list', 'handoff'].includes(local.type) && (
                    <div>
                        <label className="block text-xs font-bold text-gray-500 uppercase mb-1.5">Message Body</label>
                        <textarea 
                            className="w-full border border-gray-300 p-3 rounded-lg text-sm h-32 resize-none outline-none focus:ring-2 focus:ring-blue-500"
                            value={local.content || ''} 
                            onChange={e => update('content', e.target.value)} 
                            placeholder="Type your message here... Use {{name}} for variables."
                        />
                    </div>
                )}

                {/* Media URL */}
                {['image', 'video'].includes(local.type) && (
                    <div>
                        <label className="block text-xs font-bold text-gray-500 uppercase mb-1.5">Media URL</label>
                        <div className="flex gap-2">
                            <input className="w-full border border-gray-300 p-2.5 rounded-lg text-sm font-mono flex-1" value={local.mediaUrl || ''} onChange={e => update('mediaUrl', e.target.value)} placeholder="https://..." />
                        </div>
                    </div>
                )}

                {/* Input Validation */}
                {local.type === 'input' && (
                    <div className="space-y-4">
                        <div className="bg-orange-50 p-4 rounded-xl border border-orange-100 space-y-3">
                            <div className="flex items-center gap-2 text-orange-800 font-bold text-xs uppercase"><HelpCircle size={14} /> Validation Rules</div>
                            
                            <div>
                                <label className="block text-[10px] font-bold text-orange-800 uppercase mb-1">Save Answer To Variable</label>
                                <input className="w-full border border-orange-200 p-2 rounded text-sm bg-white font-mono" value={local.variable || ''} onChange={e => update('variable', e.target.value)} placeholder="e.g. email_address" />
                            </div>
                            
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <label className="block text-[10px] font-bold text-orange-800 uppercase mb-1">Type</label>
                                    <select className="w-full border border-orange-200 p-2 rounded text-sm bg-white" value={local.validationType || 'text'} onChange={e => update('validationType', e.target.value)}>
                                        <option value="text">Any Text</option>
                                        <option value="email">Email</option>
                                        <option value="phone">Phone</option>
                                        <option value="number">Number</option>
                                        <option value="regex">Regex</option>
                                    </select>
                                </div>
                                {local.validationType === 'regex' && (
                                    <div>
                                        <label className="block text-[10px] font-bold text-orange-800 uppercase mb-1">Pattern</label>
                                        <input className="w-full border border-orange-200 p-2 rounded text-sm bg-white font-mono" value={local.validationRegex || ''} onChange={e => update('validationRegex', e.target.value)} placeholder="^.+$" />
                                    </div>
                                )}
                            </div>
                        </div>
                        {local.validationType !== 'text' && (
                            <div>
                                <label className="block text-xs font-bold text-red-500 uppercase mb-1.5">Retry Message (On Failure)</label>
                                <textarea className="w-full border border-red-200 bg-red-50 p-2 rounded text-sm h-20 resize-none" value={local.retryMessage || ''} onChange={e => update('retryMessage', e.target.value)} placeholder="Invalid input. Please try again." />
                            </div>
                        )}
                    </div>
                )}

                {/* Buttons Config */}
                {local.type === 'interactive_button' && (
                    <div className="bg-pink-50 p-4 rounded-xl border border-pink-100">
                        <div className="flex justify-between items-center mb-2">
                            <label className="block text-xs font-bold text-pink-800 uppercase">Buttons (Max 3)</label>
                            <span className="text-[10px] text-pink-600 font-bold">{local.buttons?.length || 0}/3</span>
                        </div>
                        <div className="space-y-2">
                            {(local.buttons || []).map((btn: any, i: number) => (
                                <div key={i} className="flex gap-2">
                                    <input 
                                        className="flex-1 border border-pink-200 p-2 rounded text-sm bg-white" 
                                        value={btn.title} 
                                        onChange={e => {
                                            const n = [...local.buttons]; 
                                            n[i] = { ...n[i], title: e.target.value };
                                            update('buttons', n);
                                        }} 
                                        placeholder="Button Label"
                                        maxLength={20}
                                    />
                                    <button onClick={() => update('buttons', local.buttons.filter((_:any, idx:number) => idx !== i))} className="p-2 text-pink-500 hover:bg-pink-100 rounded"><Trash2 size={14}/></button>
                                </div>
                            ))}
                            {(local.buttons?.length || 0) < 3 && (
                                <button 
                                    onClick={() => update('buttons', [...(local.buttons||[]), { title: 'New Button', id: `btn_${Date.now()}_${Math.random()}`, type: 'reply' }])} 
                                    className="w-full py-2 border border-dashed border-pink-300 rounded text-xs font-bold text-pink-600 hover:bg-pink-100 flex items-center justify-center gap-1"
                                >
                                    <Plus size={12} /> Add Button
                                </button>
                            )}
                        </div>
                    </div>
                )}

                {/* List Config */}
                {local.type === 'interactive_list' && (
                    <div className="bg-indigo-50 p-4 rounded-xl border border-indigo-100 space-y-4">
                        <div>
                            <label className="block text-[10px] font-bold text-indigo-800 uppercase mb-1">Menu Button Label</label>
                            <input className="w-full border border-indigo-200 p-2 rounded text-sm bg-white" value={local.listButtonText || ''} onChange={e => update('listButtonText', e.target.value)} placeholder="View Options" maxLength={20} />
                        </div>

                        <div>
                            <label className="block text-[10px] font-bold text-indigo-800 uppercase mb-2">Sections & Rows</label>
                            {(local.sections || []).map((section: ListSection, sIdx: number) => (
                                <div key={sIdx} className="bg-white border border-indigo-200 rounded-lg p-3 mb-3 shadow-sm">
                                    <div className="flex gap-2 mb-2 items-center">
                                        <span className="text-[10px] text-gray-400 font-bold">SEC</span>
                                        <input 
                                            className="flex-1 font-bold text-xs border-b border-gray-200 outline-none pb-1 text-indigo-900"
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
                                            <div key={rIdx} className="flex gap-2 items-center group">
                                                <div className="w-1.5 h-1.5 bg-indigo-300 rounded-full"></div>
                                                <input 
                                                    className="flex-1 bg-gray-50 border border-gray-100 text-xs p-1.5 rounded focus:bg-white focus:border-indigo-300 outline-none transition-colors"
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
                                                }} className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100"><X size={12}/></button>
                                            </div>
                                        ))}
                                        <button 
                                            onClick={() => {
                                                const newSections = [...(local.sections || [])];
                                                newSections[sIdx].rows.push({ id: `row_${Date.now()}_${Math.random()}`, title: 'New Option' });
                                                update('sections', newSections);
                                            }}
                                            className="text-[10px] text-indigo-500 font-bold hover:underline flex items-center gap-1 mt-2"
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

                {/* Logic Config */}
                {local.type === 'condition' && (
                    <div className="bg-amber-50 p-4 rounded-xl border border-amber-100 space-y-4">
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
                                    <option value="greater_than">Greater (&gt;)</option>
                                    <option value="less_than">Less (&lt;)</option>
                                    <option value="is_set">Is Set</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-[10px] font-bold text-amber-800 uppercase mb-1">Value</label>
                                <input className="w-full border border-amber-200 p-2 rounded text-sm bg-white" value={local.value || ''} onChange={e => update('value', e.target.value)} placeholder="Target" />
                            </div>
                        </div>
                    </div>
                )}

            </div>
            
            {/* Footer */}
            <div className="p-4 border-t border-gray-200 bg-gray-50 flex justify-between items-center shrink-0">
                <span className="text-[10px] text-gray-400">Node ID: {node.id.substring(0,8)}...</span>
                <button onClick={() => {
                     const flowStore = useFlowStore.getState();
                     flowStore.deleteNode(node.id);
                     onClose();
                }} className="text-red-600 hover:bg-red-100 p-2 rounded-lg transition-colors" title="Delete Node">
                    <Trash2 size={16} />
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
    const [isSimulating, setIsSimulating] = useState(false);
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
                 console.error("Failed to load settings, using default");
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
        
        // Calculate position based on drop coordinates relative to the ReactFlow bounds
        const reactFlowBounds = document.querySelector('.react-flow')?.getBoundingClientRect();
        if (!reactFlowBounds) return;

        const position = { 
            x: event.clientX - reactFlowBounds.left - 100, // Offset to center on mouse
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
                content: '',
                buttons: type === 'interactive_button' ? [{ id: `btn_${Date.now()}_1`, title: 'Yes', type: 'reply'}, { id: `btn_${Date.now()}_2`, title: 'No', type: 'reply'}] : undefined,
                sections: type === 'interactive_list' ? [{ title: 'Main Menu', rows: [{id: `row_${Date.now()}_1`, title: 'Option 1'}] }] : undefined
            }
        };
        addNode(newNode);
        setSelectedNodeId(newNode.id);
    };

    const handleSave = async (publish = false) => {
        setIsSaving(true);
        
        // Ensure Start Node Exists
        if (!nodes.find(n => n.type === 'start' || n.data.type === 'start')) {
            alert("Error: Flow must have a Start Node.");
            setIsSaving(false);
            return;
        }

        // Basic Validation
        const invalidNode = nodes.find(n => 
            (['text', 'input'].includes(n.data.type) && !n.data.content) || 
            (n.data.type === 'interactive_button' && (!n.data.buttons || n.data.buttons.length === 0))
        );

        if (invalidNode) {
            alert(`Error: Node "${invalidNode.data.label}" has missing content.`);
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
            // Use a toast instead of alert ideally, but for now:
            const msg = publish ? "Bot Published Successfully!" : "Draft Saved.";
            console.log(msg); // Replace with toast if available
        } catch(e) { alert("Error saving flow."); }
        finally { setIsSaving(false); }
    };

    const selectedNode = useMemo(() => nodes.find(n => n.id === selectedNodeId), [selectedNodeId, nodes]);

    // Tool Palette
    const tools = [
        { category: "Messages", items: [
            { type: 'text', label: 'Text', icon: <MessageSquare size={16} />, color: 'text-blue-600 bg-blue-50' },
            { type: 'image', label: 'Media', icon: <ImageIcon size={16} />, color: 'text-purple-600 bg-purple-50' },
        ]},
        { category: "Interactive", items: [
            { type: 'interactive_button', label: 'Buttons', icon: <MousePointer size={16} />, color: 'text-pink-600 bg-pink-50' },
            { type: 'interactive_list', label: 'List Menu', icon: <List size={16} />, color: 'text-indigo-600 bg-indigo-50' },
        ]},
        { category: "Logic & Actions", items: [
            { type: 'input', label: 'Collect Input', icon: <HelpCircle size={16} />, color: 'text-orange-600 bg-orange-50' },
            { type: 'condition', label: 'Branching', icon: <GitBranch size={16} />, color: 'text-amber-600 bg-amber-50' },
            { type: 'handoff', label: 'Agent Handoff', icon: <User size={16} />, color: 'text-red-600 bg-red-50' },
            { type: 'status_update', label: 'Set Status', icon: <Check size={16} />, color: 'text-cyan-600 bg-cyan-50' },
        ]}
    ];

    return (
        <div className="flex h-screen w-full bg-slate-100 overflow-hidden font-sans">
            {/* 1. Sidebar Palette */}
            <div className="w-60 bg-white border-r border-gray-200 flex flex-col shrink-0 z-10 shadow-sm relative">
                <div className="p-5 border-b border-gray-100 bg-white">
                    <h2 className="font-bold text-gray-900 flex items-center gap-2"><LayoutTemplate size={20} className="text-blue-600" /> Bot Studio</h2>
                    <p className="text-[10px] text-gray-400 mt-1 uppercase tracking-wider font-bold">Visual Flow Builder</p>
                </div>
                <div className="p-4 space-y-6 overflow-y-auto flex-1 bg-gray-50/30">
                    {tools.map((cat, i) => (
                        <div key={i}>
                            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2 pl-1">{cat.category}</div>
                            <div className="space-y-2">
                                {cat.items.map((t) => (
                                    <div 
                                        key={t.type}
                                        draggable 
                                        onDragStart={(e) => onDragStart(e, t.type as NodeType, t.label)} 
                                        className="group p-3 bg-white border border-gray-200 rounded-xl shadow-sm cursor-grab hover:border-blue-400 hover:shadow-md transition-all flex items-center gap-3 active:scale-95"
                                    >
                                        <div className={`p-2 rounded-lg transition-colors ${t.color}`}>{t.icon}</div>
                                        <span className="text-xs font-bold text-gray-700 group-hover:text-blue-700">{t.label}</span>
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

            {/* 4. Simulator Overlay */}
            {isSimulating && (
                <div className="absolute inset-y-0 right-0 w-96 bg-white border-l shadow-2xl z-50 flex flex-col animate-in slide-in-from-right duration-300">
                    <div className="p-4 bg-gray-900 text-white flex justify-between items-center shrink-0">
                        <div className="font-bold flex items-center gap-2"><Phone size={18} /> Simulator</div>
                        <button onClick={() => setIsSimulating(false)} className="hover:bg-gray-700 p-1 rounded"><X size={20} /></button>
                    </div>
                    <div className="flex-1 bg-[#efe7dd] p-4 overflow-y-auto space-y-4">
                        <div className="text-center text-xs text-gray-500 bg-[#e1f2fb] py-1 rounded-lg border border-[#ccebf8] shadow-sm text-shadow-sm mb-6">🔒 Messages are end-to-end encrypted</div>
                        <div className="flex justify-start"><div className="bg-white p-3 rounded-lg rounded-tl-none shadow-sm text-sm max-w-[85%] text-gray-800">Hello! I'm the Bot.</div></div>
                    </div>
                    <div className="p-3 bg-gray-50 border-t shrink-0">
                        <input className="w-full border rounded-full px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-green-500" placeholder="Type a message..." disabled />
                    </div>
                </div>
            )}
        </div>
    );
};
