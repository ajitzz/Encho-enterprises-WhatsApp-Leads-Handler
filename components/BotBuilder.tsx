
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
  Node,
  Edge
} from '@xyflow/react';
import { useFlowStore } from '../services/flowStore';
import { liveApiService } from '../services/liveApiService';
import { 
  MessageSquare, FileText, List, GitBranch, 
  Settings, Save, Play, AlertTriangle, Trash2, 
  Plus, Check, X, Phone, Mail, Hash, User, Briefcase,
  HelpCircle, Eye, RefreshCw, LayoutTemplate
} from 'lucide-react';
import { FlowNodeData, NodeType } from '../types';

// --- CUSTOM NODES ---

const NodeHeader = ({ label, icon, color }: any) => (
    <div className={`px-3 py-2 ${color} flex items-center justify-between rounded-t-lg border-b border-black/5`}>
        <div className="flex items-center gap-2 text-white font-bold text-xs uppercase tracking-wide">
            {icon} {label}
        </div>
    </div>
);

const CustomNode = ({ data, selected }: { data: FlowNodeData, selected: boolean }) => {
    let color = 'bg-slate-600';
    let icon = <MessageSquare size={12} />;
    
    switch(data.type) {
        case 'question': color = 'bg-blue-600'; icon = <HelpCircle size={12} />; break;
        case 'condition': color = 'bg-amber-600'; icon = <GitBranch size={12} />; break;
        case 'buttons': color = 'bg-violet-600'; icon = <List size={12} />; break;
        case 'document': color = 'bg-orange-500'; icon = <FileText size={12} />; break;
        case 'status': color = 'bg-green-600'; icon = <Check size={12} />; break;
        case 'handoff': color = 'bg-red-500'; icon = <User size={12} />; break;
    }

    return (
        <div className={`w-[280px] bg-white rounded-lg shadow-lg border-2 transition-all ${selected ? 'border-blue-500 ring-2 ring-blue-200' : 'border-gray-200'}`}>
            <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-gray-400" />
            
            <NodeHeader label={data.label || data.type} icon={icon} color={color} />
            
            <div className="p-3 text-xs text-gray-700 font-medium">
                {data.content ? (
                    <div className="line-clamp-3 whitespace-pre-wrap">{data.content}</div>
                ) : (
                    <span className="italic text-gray-400">No content set...</span>
                )}
                
                {/* Visual Indicators */}
                {data.variable && <div className="mt-2 text-[10px] bg-blue-50 text-blue-700 px-2 py-1 rounded border border-blue-100 flex items-center gap-1"><Hash size={10} /> Save to: {data.variable}</div>}
                
                {data.warning && (
                    <div className="mt-2 text-[10px] bg-red-50 text-red-600 px-2 py-1 rounded border border-red-100 flex items-center gap-1 font-bold">
                        <AlertTriangle size={10} /> {data.warning}
                    </div>
                )}
            </div>

            {/* Dynamic Handles for Branches */}
            {data.type === 'buttons' && data.buttons?.map((btn, i) => (
                <div key={i} className="relative mt-1 text-right px-2 pb-1">
                    <span className="text-[10px] bg-gray-100 px-2 py-0.5 rounded text-gray-600 border border-gray-200">{btn.title}</span>
                    <Handle type="source" position={Position.Right} id={btn.id || btn.title} className="!bg-violet-500 !w-2.5 !h-2.5 !right-[-6px]" style={{top: '50%'}} />
                </div>
            ))}

            {data.type === 'condition' && (
                <div className="space-y-1 mt-1 pb-2">
                    <div className="relative text-right px-2"><span className="text-[10px] text-green-600 font-bold">TRUE</span><Handle type="source" position={Position.Right} id="true" className="!bg-green-500" /></div>
                    <div className="relative text-right px-2"><span className="text-[10px] text-red-600 font-bold">FALSE</span><Handle type="source" position={Position.Right} id="false" className="!bg-red-500" /></div>
                </div>
            )}

            {/* Default Output */}
            {['message', 'question', 'document', 'status'].includes(data.type) && (
                <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-blue-500" />
            )}
        </div>
    );
};

const Inspector = ({ node, onChange }: { node: Node, onChange: (id: string, d: any) => void }) => {
    const [local, setLocal] = useState(node.data as any);
    useEffect(() => setLocal(node.data), [node]);

    const update = (k: string, v: any) => {
        const n = { ...local, [k]: v };
        setLocal(n);
        onChange(node.id, n);
    };

    return (
        <div className="w-80 bg-white border-l border-gray-200 h-full flex flex-col shadow-xl z-20">
            <div className="p-4 border-b bg-gray-50 flex justify-between items-center">
                <h3 className="font-bold text-gray-800 uppercase text-xs tracking-wider">{local.type} Settings</h3>
            </div>
            <div className="p-4 space-y-4 flex-1 overflow-y-auto">
                <div>
                    <label className="block text-xs font-bold text-gray-500 mb-1">Label (Internal)</label>
                    <input className="w-full border p-2 rounded text-sm" value={local.label} onChange={e => update('label', e.target.value)} />
                </div>

                {['message', 'question', 'buttons', 'handoff'].includes(local.type) && (
                    <div>
                        <label className="block text-xs font-bold text-gray-500 mb-1">Message Text</label>
                        <textarea 
                            className="w-full border p-2 rounded text-sm h-32 resize-none" 
                            value={local.content || ''} 
                            onChange={e => update('content', e.target.value)} 
                            placeholder="Hello! How can I help?"
                        />
                        <div className="text-[10px] text-gray-400 text-right mt-1">{local.content?.length || 0} / 1024 chars</div>
                    </div>
                )}

                {['question', 'document'].includes(local.type) && (
                    <div className="bg-blue-50 p-3 rounded border border-blue-100 space-y-3">
                        <label className="block text-xs font-bold text-blue-800">Save Answer To Variable</label>
                        <input className="w-full border p-2 rounded text-sm font-mono" value={local.variable || ''} onChange={e => update('variable', e.target.value)} placeholder="e.g. candidate_name" />
                        
                        {local.type === 'question' && (
                            <>
                                <label className="block text-xs font-bold text-blue-800">Validation Type</label>
                                <select 
                                    className="w-full border p-2 rounded text-sm"
                                    value={local.validation?.type || 'text'}
                                    onChange={e => update('validation', { type: e.target.value })}
                                >
                                    <option value="text">Any Text</option>
                                    <option value="number">Number</option>
                                    <option value="email">Email</option>
                                    <option value="phone">Phone Number</option>
                                </select>
                            </>
                        )}
                    </div>
                )}

                {local.type === 'buttons' && (
                    <div className="space-y-2">
                        <label className="block text-xs font-bold text-gray-500">Buttons (Max 3)</label>
                        {(local.buttons || []).map((btn: any, i: number) => (
                            <div key={i} className="flex gap-2">
                                <input className="flex-1 border p-2 rounded text-sm" value={btn.title} onChange={e => {
                                    const n = [...local.buttons]; n[i].title = e.target.value; update('buttons', n);
                                }} />
                                <button onClick={() => update('buttons', local.buttons.filter((_:any, idx:number) => idx !== i))} className="text-red-500"><Trash2 size={14}/></button>
                            </div>
                        ))}
                        {(local.buttons?.length || 0) < 3 && (
                            <button onClick={() => update('buttons', [...(local.buttons||[]), { title: 'New Option', id: Date.now().toString() }])} className="text-xs text-blue-600 font-bold flex items-center gap-1">+ Add Button</button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

export const BotBuilder = () => {
    const { nodes, edges, onNodesChange, onEdgesChange, onConnect, addNode, updateNodeData, setNodes, setEdges } = useFlowStore();
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [isSimulating, setIsSimulating] = useState(false);
    
    // Load Draft
    useEffect(() => {
        liveApiService.getBotSettings().then(data => {
            if (data?.nodes) {
                setNodes(data.nodes);
                setEdges(data.edges);
            }
        });
    }, []);

    const onDragStart = (event: React.DragEvent, nodeType: NodeType, label: string) => {
        event.dataTransfer.setData('application/reactflow/type', nodeType);
        event.dataTransfer.setData('application/reactflow/label', label);
        event.dataTransfer.effectAllowed = 'move';
    };

    const onDrop = (event: React.DragEvent) => {
        event.preventDefault();
        const type = event.dataTransfer.getData('application/reactflow/type') as NodeType;
        const label = event.dataTransfer.getData('application/reactflow/label');
        
        const position = { x: event.clientX - 300, y: event.clientY - 100 }; // rough offset
        const newNode: Node = {
            id: `node_${Date.now()}`,
            type: 'custom',
            position,
            data: { id: `node_${Date.now()}`, type, label, content: '' }
        };
        addNode(newNode);
    };

    const handleSave = async (publish = false) => {
        const payload = { nodes, edges };
        try {
            await liveApiService.saveBotSettings(payload); // Save draft
            if (publish) await liveApiService.publishBot();
            alert(publish ? "Published Live!" : "Draft Saved.");
        } catch(e) { alert("Error saving"); }
    };

    const selectedNode = useMemo(() => nodes.find(n => n.id === selectedNodeId), [selectedNodeId, nodes]);

    return (
        <div className="flex h-screen w-full bg-gray-50 overflow-hidden">
            {/* Sidebar */}
            <div className="w-64 bg-white border-r flex flex-col shrink-0 z-10 shadow-sm">
                <div className="p-4 border-b bg-gray-50">
                    <h2 className="font-bold text-gray-800 flex items-center gap-2"><LayoutTemplate size={18} /> Tools</h2>
                </div>
                <div className="p-4 space-y-3 overflow-y-auto flex-1">
                    <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Interaction</div>
                    <div draggable onDragStart={(e) => onDragStart(e, 'message', 'Send Message')} className="p-3 bg-white border rounded-lg shadow-sm cursor-grab hover:border-blue-400 flex items-center gap-2 text-sm font-medium"><MessageSquare size={16} className="text-slate-600" /> Send Text</div>
                    <div draggable onDragStart={(e) => onDragStart(e, 'question', 'Ask Question')} className="p-3 bg-white border rounded-lg shadow-sm cursor-grab hover:border-blue-400 flex items-center gap-2 text-sm font-medium"><HelpCircle size={16} className="text-blue-600" /> Ask Question</div>
                    <div draggable onDragStart={(e) => onDragStart(e, 'buttons', 'Buttons')} className="p-3 bg-white border rounded-lg shadow-sm cursor-grab hover:border-blue-400 flex items-center gap-2 text-sm font-medium"><List size={16} className="text-violet-600" /> Buttons</div>
                    
                    <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mt-4">Logic</div>
                    <div draggable onDragStart={(e) => onDragStart(e, 'condition', 'Condition')} className="p-3 bg-white border rounded-lg shadow-sm cursor-grab hover:border-blue-400 flex items-center gap-2 text-sm font-medium"><GitBranch size={16} className="text-amber-600" /> Condition</div>
                    <div draggable onDragStart={(e) => onDragStart(e, 'handoff', 'Handoff')} className="p-3 bg-white border rounded-lg shadow-sm cursor-grab hover:border-blue-400 flex items-center gap-2 text-sm font-medium"><User size={16} className="text-red-600" /> Human Agent</div>
                </div>
            </div>

            {/* Canvas */}
            <div className="flex-1 relative h-full flex flex-col">
                <div className="absolute top-4 right-4 z-20 flex gap-2">
                    <button onClick={() => setIsSimulating(!isSimulating)} className={`px-4 py-2 rounded-full font-bold shadow-lg transition-all flex items-center gap-2 ${isSimulating ? 'bg-amber-500 text-white' : 'bg-white text-gray-700'}`}>
                        {isSimulating ? <RefreshCw size={16} className="animate-spin" /> : <Play size={16} />} Simulator
                    </button>
                    <button onClick={() => handleSave(false)} className="px-4 py-2 bg-white text-gray-700 rounded-full font-bold shadow-lg hover:bg-gray-50 flex items-center gap-2"><Save size={16} /> Draft</button>
                    <button onClick={() => handleSave(true)} className="px-4 py-2 bg-black text-white rounded-full font-bold shadow-lg hover:bg-gray-800 flex items-center gap-2"><LayoutTemplate size={16} /> Publish</button>
                </div>

                <div className="flex-1" onDrop={onDrop} onDragOver={e => e.preventDefault()}>
                    <ReactFlow
                        nodes={nodes}
                        edges={edges}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onConnect={onConnect}
                        nodeTypes={{ custom: CustomNode }}
                        onNodeClick={(_, n) => setSelectedNodeId(n.id)}
                        onPaneClick={() => setSelectedNodeId(null)}
                        fitView
                    >
                        <Background color="#cbd5e1" gap={16} variant={BackgroundVariant.Dots} />
                        <Controls />
                        <MiniMap nodeColor="#94a3b8" />
                    </ReactFlow>
                </div>
            </div>

            {/* Inspector Panel */}
            {selectedNode && !isSimulating && <Inspector node={selectedNode} onChange={updateNodeData} />}

            {/* Simulator Panel (Overlay) */}
            {isSimulating && (
                <div className="w-96 bg-white border-l shadow-2xl z-30 flex flex-col animate-in slide-in-from-right">
                    <div className="p-4 bg-gray-900 text-white flex justify-between items-center">
                        <div className="font-bold flex items-center gap-2"><Phone size={16} /> Simulator</div>
                        <button onClick={() => setIsSimulating(false)}><X size={18} /></button>
                    </div>
                    <div className="flex-1 bg-slate-100 p-4 overflow-y-auto">
                        <div className="text-center text-xs text-gray-400 my-4">-- Session Started --</div>
                        {/* Mock Chat UI */}
                        <div className="flex justify-start mb-2"><div className="bg-white p-3 rounded-lg rounded-tl-none shadow-sm text-sm max-w-[80%]">👋 Welcome! Are you looking for a job?</div></div>
                        <div className="flex justify-end mb-2"><div className="bg-green-600 text-white p-3 rounded-lg rounded-tr-none shadow-sm text-sm max-w-[80%]">Yes</div></div>
                    </div>
                    <div className="p-3 bg-white border-t">
                        <input className="w-full border rounded-full px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" placeholder="Type a message..." />
                    </div>
                </div>
            )}
        </div>
    );
};
