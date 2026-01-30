
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
  Edge
} from '@xyflow/react';
import { useFlowStore } from '../services/flowStore';
import { liveApiService } from '../services/liveApiService';
import { mockBackend } from '../services/mockBackend';
import { auditBotFlow } from '../services/geminiService';
import { 
  MessageSquare, FileText, List, GitBranch, 
  Save, Play, AlertTriangle, Trash2, 
  Check, User, HelpCircle, Phone, X, LayoutTemplate, RefreshCw, ShieldCheck, AlertOctagon, Sparkles
} from 'lucide-react';
import { AuditReport, FlowNodeData, NodeType } from '../types';

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

    const isPlaceholder = !data.content || /replace this|sample message|enter your message|type your message|enter text/i.test(data.content);

    return (
        <div className={`w-[280px] bg-white rounded-lg shadow-lg border-2 transition-all ${selected ? 'border-blue-500 ring-2 ring-blue-200' : (isPlaceholder && ['message', 'question', 'buttons'].includes(data.type) ? 'border-red-400 bg-red-50' : 'border-gray-200')}`}>
            <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-gray-400" />
            
            <NodeHeader label={data.label || data.type} icon={icon} color={color} />
            
            <div className="p-3 text-xs text-gray-700 font-medium">
                {data.content ? (
                    <div className="line-clamp-3 whitespace-pre-wrap">{data.content}</div>
                ) : (
                    <span className="italic text-red-500 font-bold flex items-center gap-1"><AlertTriangle size={10} /> Message Required</span>
                )}
                
                {/* Visual Indicators */}
                {data.variable && <div className="mt-2 text-[10px] bg-blue-50 text-blue-700 px-2 py-1 rounded border border-blue-100 flex items-center gap-1">Save to: {data.variable}</div>}
                
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

const Inspector = ({ node, onChange, className }: { node: Node<FlowNodeData>, onChange: (id: string, d: any) => void, className?: string }) => {
    const [local, setLocal] = useState(node.data as any);
    useEffect(() => setLocal(node.data), [node]);

    const update = (k: string, v: any) => {
        const n = { ...local, [k]: v };
        setLocal(n);
        onChange(node.id, n);
    };

    const hasPlaceholder = (!local.content || /replace this|sample message|enter your message|type your message/i.test(local.content));

    return (
        <div className={`bg-white h-full flex flex-col ${className || ''}`}>
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
                        <label className="block text-xs font-bold text-gray-500 mb-1">Message Text <span className="text-red-500">*</span></label>
                        <textarea 
                            className={`w-full border p-2 rounded text-sm h-32 resize-none ${hasPlaceholder ? 'border-red-300 ring-1 ring-red-100' : 'border-gray-300'}`}
                            value={local.content || ''} 
                            onChange={e => update('content', e.target.value)} 
                            placeholder="Enter the message the user will see..."
                        />
                        {hasPlaceholder && (
                            <div className="text-[10px] text-red-500 mt-1 font-bold flex items-center gap-1"><AlertTriangle size={10} /> Valid message required (No placeholders)</div>
                        )}
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

export const BotBuilder = ({ isLiveMode }: { isLiveMode: boolean }) => {
    const { nodes, edges, onNodesChange, onEdgesChange, onConnect, addNode, updateNodeData, setNodes, setEdges } = useFlowStore();
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [isSimulating, setIsSimulating] = useState(false);
    const [auditReport, setAuditReport] = useState<AuditReport | null>(null);
    const [isAuditing, setIsAuditing] = useState(false);
    const [lastAuditAt, setLastAuditAt] = useState<Date | null>(null);
    const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
    
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
        // INITIALIZATION FIX: Start with EMPTY string to force user input, never use a placeholder.
        const newNode: Node<FlowNodeData> = {
            id: `node_${Date.now()}`,
            type: 'custom',
            position,
            data: { id: `node_${Date.now()}`, type, label, content: '' }
        };
        addNode(newNode);
        // Auto-select to prompt editing
        setSelectedNodeId(newNode.id);
    };

    // STRICT VALIDATION
    const validateNodes = (nodesToSave: Node<FlowNodeData>[]) => {
        const errors: string[] = [];
        const BAD_PATTERNS = [/replace this/i, /sample message/i, /enter your message/i, /type your message/i, /insert text/i];
        
        nodesToSave.forEach(node => {
            if (node.type === 'custom') {
                const { label, content, type } = node.data;
                // Only validate output nodes
                if (['message', 'question', 'buttons', 'handoff'].includes(type)) {
                     if (!content || !content.toString().trim()) {
                         errors.push(`Node "${label}" is empty. Please enter text.`);
                     } else if (BAD_PATTERNS.some(p => p.test(content))) {
                         errors.push(`Node "${label}" has placeholder text. Please replace it with a real message.`);
                     }
                }
            }
        });
        return errors;
    };

    const runAudit = useCallback(async () => {
        setIsAuditing(true);
        try {
            const report = await auditBotFlow(nodes);
            setAuditReport(report);
            setLastAuditAt(new Date());
            return report;
        } finally {
            setIsAuditing(false);
        }
    }, [nodes]);

    const applyAutoFixes = () => {
        if (!auditReport) return;
        auditReport.issues.forEach(issue => {
            if (!issue.autoFixValue) return;
            const node = nodes.find(n => n.id === issue.nodeId);
            if (!node) return;
            updateNodeData(issue.nodeId, { ...node.data, content: issue.autoFixValue });
        });
    };

    const handleSave = async (publish = false) => {
        const errors = validateNodes(nodes);
        if (errors.length > 0) {
            alert(`⚠️ Cannot ${publish ? 'Publish' : 'Save'}: Invalid Bot Content\n\nTo prevent sending bad messages to customers, please fix:\n\n${errors.map(e => `• ${e}`).join('\n')}`);
            return;
        }

        if (publish) {
            const report = await runAudit();
            const criticalIssues = report.issues.filter(issue => issue.severity === 'CRITICAL');
            if (criticalIssues.length > 0) {
                alert(`⚠️ Publish blocked. Resolve ${criticalIssues.length} critical audit issue(s) before publishing.`);
                return;
            }
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
            setLastSavedAt(new Date());
            alert(publish ? "Published Live!" : "Draft Saved.");
        } catch(e) { alert("Error saving"); }
    };

    const selectedNode = useMemo(() => nodes.find(n => n.id === selectedNodeId), [selectedNodeId, nodes]);
    const flowStats = useMemo(() => {
        const linkedNodeIds = new Set<string>();
        edges.forEach(edge => {
            if (edge.source) linkedNodeIds.add(edge.source);
            if (edge.target) linkedNodeIds.add(edge.target);
        });
        const missingContent = nodes.filter(node => {
            const { type, content } = node.data || {};
            return ['message', 'question', 'buttons', 'handoff'].includes(type) && (!content || !content.toString().trim());
        });
        const placeholderNodes = nodes.filter(node => {
            const { content } = node.data || {};
            return typeof content === 'string' && /replace this|sample message|enter your message|type your message|insert text/i.test(content);
        });
        const orphanNodes = nodes.filter(node => !linkedNodeIds.has(node.id));
        const issues = auditReport?.issues || [];
        const critical = issues.filter(issue => issue.severity === 'CRITICAL').length;
        const warnings = issues.filter(issue => issue.severity === 'WARNING').length;
        return { missingContent, placeholderNodes, orphanNodes, critical, warnings };
    }, [nodes, edges, auditReport]);

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
                    <button onClick={runAudit} disabled={isAuditing} className="px-4 py-2 bg-white text-gray-700 rounded-full font-bold shadow-lg hover:bg-gray-50 flex items-center gap-2 disabled:opacity-50">
                        {isAuditing ? <RefreshCw size={16} className="animate-spin" /> : <ShieldCheck size={16} />} Audit
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

            {!isSimulating && (
                <div className="w-96 bg-white border-l border-gray-200 h-full flex flex-col shadow-xl z-20">
                    {selectedNode ? (
                        <Inspector node={selectedNode} onChange={updateNodeData} className="flex-1" />
                    ) : (
                        <div className="p-6 text-sm text-gray-400 border-b">Select a node to edit settings.</div>
                    )}
                    <div className="border-t bg-gray-50 p-4">
                        <div className="flex items-center justify-between">
                            <h3 className="font-bold text-gray-800 uppercase text-xs tracking-wider">Flow Quality</h3>
                            <button onClick={runAudit} disabled={isAuditing} className="text-xs font-bold text-blue-600 disabled:opacity-50">
                                {isAuditing ? 'Auditing…' : 'Run Audit'}
                            </button>
                        </div>
                    </div>
                    <div className="p-4 space-y-4 overflow-y-auto flex-1">
                        <div className="grid grid-cols-2 gap-3 text-xs">
                            <div className="p-3 rounded-lg border bg-white">
                                <div className="text-[10px] text-gray-400 font-bold uppercase">Nodes</div>
                                <div className="text-lg font-bold">{nodes.length}</div>
                            </div>
                            <div className="p-3 rounded-lg border bg-white">
                                <div className="text-[10px] text-gray-400 font-bold uppercase">Edges</div>
                                <div className="text-lg font-bold">{edges.length}</div>
                            </div>
                            <div className="p-3 rounded-lg border bg-white">
                                <div className="text-[10px] text-gray-400 font-bold uppercase">Orphans</div>
                                <div className="text-lg font-bold">{flowStats.orphanNodes.length}</div>
                            </div>
                            <div className="p-3 rounded-lg border bg-white">
                                <div className="text-[10px] text-gray-400 font-bold uppercase">Missing Copy</div>
                                <div className="text-lg font-bold">{flowStats.missingContent.length}</div>
                            </div>
                        </div>

                        <div className="space-y-2">
                            <div className="flex items-center gap-2 text-xs font-bold text-gray-600">
                                <Sparkles size={14} /> Release Readiness
                            </div>
                            <div className={`p-3 rounded-lg border ${flowStats.critical > 0 ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'}`}>
                                <div className="flex items-center gap-2 text-xs font-bold">
                                    {flowStats.critical > 0 ? <AlertOctagon size={14} className="text-red-600" /> : <ShieldCheck size={14} className="text-green-600" />}
                                    {flowStats.critical > 0 ? `${flowStats.critical} Critical issue(s)` : 'No critical issues detected'}
                                </div>
                                <div className="text-[10px] text-gray-500 mt-1">
                                    {lastAuditAt ? `Last audit: ${lastAuditAt.toLocaleTimeString()}` : 'Run audit to verify logic.'}
                                </div>
                            </div>
                            {flowStats.warnings > 0 && (
                                <div className="text-[10px] text-amber-600 font-semibold">{flowStats.warnings} warning(s) to review.</div>
                            )}
                        </div>

                        {auditReport && auditReport.issues.length > 0 && (
                            <div className="space-y-2">
                                <div className="text-xs font-bold text-gray-600">Audit Findings</div>
                                <div className="space-y-2">
                                    {auditReport.issues.map(issue => (
                                        <div key={`${issue.nodeId}-${issue.issue}`} className="p-2 rounded-lg border bg-white text-[11px]">
                                            <div className="flex items-center justify-between">
                                                <span className="font-bold">{issue.issue}</span>
                                                <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${issue.severity === 'CRITICAL' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                                                    {issue.severity}
                                                </span>
                                            </div>
                                            <div className="text-gray-500 mt-1">{issue.suggestion}</div>
                                        </div>
                                    ))}
                                </div>
                                {auditReport.issues.some(issue => issue.autoFixValue) && (
                                    <button onClick={applyAutoFixes} className="text-xs font-bold text-blue-600">Apply Auto-Fixes</button>
                                )}
                            </div>
                        )}

                        {flowStats.placeholderNodes.length > 0 && (
                            <div className="p-3 rounded-lg border border-amber-200 bg-amber-50 text-[11px] text-amber-700">
                                {flowStats.placeholderNodes.length} node(s) still contain placeholder copy.
                            </div>
                        )}

                        <div className="text-[10px] text-gray-400">
                            {lastSavedAt ? `Last saved at ${lastSavedAt.toLocaleTimeString()}` : 'No saves yet.'}
                        </div>
                    </div>
                </div>
            )}

            {/* Simulator (Overlay) */}
            {isSimulating && (
                <div className="w-96 bg-white border-l shadow-2xl z-30 flex flex-col animate-in slide-in-from-right absolute right-0 top-0 bottom-0">
                    <div className="p-4 bg-gray-900 text-white flex justify-between items-center">
                        <div className="font-bold flex items-center gap-2"><Phone size={16} /> Simulator</div>
                        <button onClick={() => setIsSimulating(false)}><X size={18} /></button>
                    </div>
                    <div className="flex-1 bg-slate-100 p-4 overflow-y-auto">
                        <div className="text-center text-xs text-gray-400 my-4">-- Session Started --</div>
                        <div className="flex justify-start mb-2"><div className="bg-white p-3 rounded-lg rounded-tl-none shadow-sm text-sm max-w-[80%]">👋 Simulator Active</div></div>
                    </div>
                    <div className="p-3 bg-white border-t">
                        <input className="w-full border rounded-full px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500" placeholder="Type a message..." />
                    </div>
                </div>
            )}
        </div>
    );
};
