import React, { useState, useCallback, useRef, useEffect } from 'react';
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
  Panel,
  ReactFlowProvider,
  useReactFlow
} from '@xyflow/react';
import { BotSettings, BotStep } from '../types';
import { mockBackend } from '../services/mockBackend';
import { liveApiService } from '../services/liveApiService';
import { 
  Save, MessageSquare, Image as ImageIcon, 
  List, Type, Split, Zap, GripVertical, Trash2, 
  Copy, Plus, Settings2, Play, AlertCircle 
} from 'lucide-react';

// --- CUSTOM NODE COMPONENT ---
// This component renders the individual card in the canvas
const BuilderNode = ({ data, id, selected }: any) => {
  const [options, setOptions] = useState<string[]>(data.options || []);

  const addOption = () => {
    const newOpts = [...options, `Option ${options.length + 1}`];
    setOptions(newOpts);
    data.onChange?.(id, { ...data, options: newOpts });
  };

  const removeOption = (idx: number) => {
    const newOpts = options.filter((_, i) => i !== idx);
    setOptions(newOpts);
    data.onChange?.(id, { ...data, options: newOpts });
  };

  const updateOption = (idx: number, val: string) => {
    const newOpts = [...options];
    newOpts[idx] = val;
    setOptions(newOpts);
    data.onChange?.(id, { ...data, options: newOpts });
  };

  const handleChange = (field: string, value: any) => {
    data.onChange?.(id, { ...data, [field]: value });
  };

  return (
    <div className={`w-80 bg-white rounded-xl shadow-lg border-2 transition-all duration-200 group ${selected ? 'border-blue-500 ring-4 ring-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
      
      {/* Target Handle (Input) */}
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !-left-2 !bg-blue-500 border-2 border-white" />

      {/* Header */}
      <div className="bg-gray-50 px-4 py-3 border-b border-gray-100 rounded-t-lg flex items-center justify-between handle cursor-grab active:cursor-grabbing">
        <div className="flex items-center gap-2">
           <div className="p-1.5 bg-white rounded border border-gray-200 text-gray-500 shadow-sm">
              {data.icon || <MessageSquare size={14} />}
           </div>
           <div>
             <span className="text-xs font-bold text-gray-400 uppercase tracking-wider block leading-none mb-0.5">{data.label || 'Step'}</span>
             <input 
                className="bg-transparent border-none p-0 text-sm font-semibold text-gray-900 focus:ring-0 w-32 leading-none"
                value={data.title}
                onChange={(e) => handleChange('title', e.target.value)}
                placeholder="Step Name"
             />
           </div>
        </div>
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={() => data.onDelete?.(id)} className="p-1 hover:text-red-500 text-gray-400 transition-colors">
                <Trash2 size={14} />
            </button>
        </div>
      </div>

      {/* Body */}
      <div className="p-4 space-y-4">
        
        {/* Message Input */}
        <div>
           <label className="text-[10px] font-bold text-gray-400 uppercase mb-1.5 block">Bot Message</label>
           <textarea 
             className="w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-blue-500 focus:bg-white outline-none resize-none transition-all"
             rows={3}
             placeholder="Type your question..."
             value={data.message}
             onChange={(e) => handleChange('message', e.target.value)}
           />
        </div>

        {/* Media Placeholder */}
        {data.hasMedia && (
            <div className="border-2 border-dashed border-gray-200 rounded-lg p-4 flex flex-col items-center justify-center text-gray-400 hover:bg-gray-50 hover:border-blue-300 transition-colors cursor-pointer group/media">
                <ImageIcon size={24} className="mb-2 group-hover/media:text-blue-500" />
                <span className="text-xs font-medium">Upload Image/Video</span>
            </div>
        )}

        {/* Dynamic Options / Buttons */}
        {data.inputType === 'option' && (
           <div className="space-y-2">
             <div className="flex items-center justify-between">
                <label className="text-[10px] font-bold text-gray-400 uppercase">Choices & Branching</label>
                <button onClick={addOption} className="text-[10px] bg-blue-50 text-blue-600 px-2 py-0.5 rounded font-bold hover:bg-blue-100">
                    + Add
                </button>
             </div>
             <div className="space-y-2">
                {options.map((opt, idx) => (
                    <div key={idx} className="relative flex items-center">
                        <input 
                          value={opt}
                          onChange={(e) => updateOption(idx, e.target.value)}
                          className="w-full bg-white border border-gray-200 rounded-md px-3 py-1.5 text-sm focus:border-blue-500 outline-none pr-8"
                        />
                        <button onClick={() => removeOption(idx)} className="absolute right-2 text-gray-300 hover:text-red-500">
                            <Trash2 size={12} />
                        </button>
                        {/* Source Handle for this specific option */}
                        <Handle 
                            type="source" 
                            position={Position.Right} 
                            id={`opt_${idx}`}
                            className="!w-3 !h-3 !-right-5 !bg-blue-500 border-2 border-white"
                            style={{ top: '50%', transform: 'translateY(-50%)' }}
                        />
                    </div>
                ))}
             </div>
           </div>
        )}

        {/* Default Source Handle (If not using options to branch) */}
        {data.inputType !== 'option' && (
             <div className="relative h-4 flex items-center justify-end">
                 <span className="text-[10px] text-gray-400 mr-2">Next Step</span>
                 <Handle type="source" position={Position.Right} className="!w-3 !h-3 !-right-5 !bg-gray-400 border-2 border-white" />
             </div>
        )}

        {/* Variable Capture */}
        <div className="pt-3 border-t border-gray-100">
             <div className="flex items-center gap-2 mb-1">
                 <Zap size={12} className="text-amber-500" />
                 <label className="text-[10px] font-bold text-gray-600">Save Answer As</label>
             </div>
             <select 
               value={data.saveToField || ''}
               onChange={(e) => handleChange('saveToField', e.target.value)}
               className="w-full bg-gray-50 border border-gray-200 rounded-md px-2 py-1.5 text-xs focus:ring-2 focus:ring-blue-500 outline-none"
             >
                <option value="">Don't Save (Flow Logic Only)</option>
                <option value="name">Driver Name</option>
                <option value="vehicleRegistration">Vehicle Number</option>
                <option value="availability">Availability</option>
                <option value="document">Document List</option>
             </select>
        </div>

      </div>
    </div>
  );
};

// --- MAIN BUILDER COMPONENT ---

const nodeTypes = {
  custom: BuilderNode,
};

const initialNodes: Node[] = [
    { 
        id: 'start', 
        type: 'custom', 
        position: { x: 100, y: 100 }, 
        data: { title: 'Welcome', message: 'Hello! Welcome to Uber Fleet.', inputType: 'text' } 
    }
];

interface BotBuilderProps {
    isLiveMode?: boolean; 
}

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

  // Load Initial Data
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

        if (settings.flowData) {
            // Restore visual state if exists
            // We need to re-attach the handlers functions to nodes
            const restoredNodes = settings.flowData.nodes.map((n: any) => ({
                ...n,
                data: {
                    ...n.data,
                    onChange: updateNodeData,
                    onDelete: deleteNode
                }
            }));
            setNodes(restoredNodes);
            setEdges(settings.flowData.edges);
        } else if (settings.steps.length > 0) {
            // Fallback: Convert linear steps to nodes (Basic conversion)
            // This is a rough conversion for backward compatibility
            const newNodes: Node[] = settings.steps.map((step, idx) => ({
                id: step.id,
                type: 'custom',
                position: { x: 100 + (idx * 350), y: 100 },
                data: {
                    title: step.title,
                    message: step.message,
                    inputType: step.inputType,
                    options: step.options,
                    saveToField: step.saveToField,
                    onChange: updateNodeData,
                    onDelete: deleteNode
                }
            }));
            
            // Generate linear edges
            const newEdges: Edge[] = [];
            settings.steps.forEach((step, idx) => {
                if (step.nextStepId && step.nextStepId !== 'END' && step.nextStepId !== 'AI_HANDOFF') {
                    newEdges.push({
                        id: `e-${step.id}-${step.nextStepId}`,
                        source: step.id,
                        target: step.nextStepId
                    });
                }
            });
            
            setNodes(newNodes);
            setEdges(newEdges);
        }
    };
    load();
  }, [isLiveMode]);

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge({ ...params, animated: true, style: { stroke: '#3b82f6', strokeWidth: 2 } }, eds)),
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

      const type = event.dataTransfer.getData('application/reactflow');
      const inputType = event.dataTransfer.getData('application/inputType');
      const label = event.dataTransfer.getData('application/label');

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
            title: label, 
            message: '', 
            inputType: inputType, 
            label: label,
            onChange: updateNodeData, 
            onDelete: deleteNode,
            options: inputType === 'option' ? ['Yes', 'No'] : undefined
        },
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [reactFlowInstance],
  );

  // --- SAVE LOGIC ---
  const handleSave = async () => {
      setIsSaving(true);
      
      // 1. Compile Graph to Linear/Branching Steps for the Backend
      const compiledSteps: BotStep[] = nodes.map(node => {
        // Find default next step
        const defaultEdge = edges.find(e => e.source === node.id && !e.sourceHandle);
        
        // If it's an option type, we might not have a simple nextStepId if it branches. 
        // For the simplified backend model in this demo, we'll try to follow the "first" connection or basic next.
        // A real production backend would need a graph executor. 
        // We will adapt the linear 'BotStep' to store 'nextStepId' as the default fall through.
        
        let nextId = defaultEdge ? defaultEdge.target : 'END';
        
        // Simple heuristic: If it's options, and we have multiple edges, the backend currently
        // supports linear steps mostly. We will assume the next step is the one connected to the first option 
        // OR simply set it to AI_HANDOFF if no connection.
        
        // In this demo revision, we will persist the visual flow to `flowData` and also update `steps` 
        // for backward compatibility with the mock engine.
        
        return {
            id: node.id,
            title: node.data.title,
            message: node.data.message,
            inputType: node.data.inputType,
            options: node.data.options,
            saveToField: node.data.saveToField,
            nextStepId: nextId
        };
      });

      // Sort steps to ensure start is first (if possible) or just trust the ID links
      // The current backend engine just looks up by ID, so order matters less, 
      // EXCEPT for the entry point which defaults to steps[0].
      // We should find the node with no incoming edges or the one named 'start' to be first.
      
      const newSettings: BotSettings = {
          ...mockBackend.getBotSettings(),
          steps: compiledSteps,
          flowData: { nodes, edges } // Save visual state
      };

      if (isLiveMode) {
          try {
             await liveApiService.saveBotSettings(newSettings);
          } catch(e) { console.error(e); }
      } else {
          mockBackend.updateBotSettings(newSettings);
      }
      
      setTimeout(() => setIsSaving(false), 800);
  };

  return (
    <div className="flex flex-col h-full bg-gray-100">
        
        {/* Top Bar */}
        <div className="bg-white border-b border-gray-200 px-6 h-16 flex items-center justify-between shrink-0 shadow-sm z-20">
            <div className="flex items-center gap-3">
                <div className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white p-2 rounded-lg shadow-md">
                    <Split size={20} />
                </div>
                <div>
                    <h1 className="text-lg font-bold text-gray-900 leading-tight">Flow Builder</h1>
                    <p className="text-xs text-gray-400">Drag nodes to design conversation</p>
                </div>
            </div>
            <div className="flex items-center gap-3">
                 <button className="text-gray-500 hover:text-gray-900 px-3 py-2 text-sm font-medium transition-colors">
                    Variables
                 </button>
                 <div className="h-6 w-px bg-gray-200"></div>
                 <button 
                    onClick={handleSave}
                    disabled={isSaving}
                    className="bg-gray-900 text-white px-5 py-2.5 rounded-lg text-sm font-bold shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition-all flex items-center gap-2"
                 >
                    {isSaving ? 'Saving...' : <><Save size={16} /> Save Flow</>}
                 </button>
            </div>
        </div>

        {/* Main Workspace */}
        <div className="flex-1 flex overflow-hidden relative">
            
            {/* CANVAS */}
            <div className="flex-1 h-full bg-gray-50 relative" onDragOver={onDragOver} onDrop={onDrop}>
                 <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    nodeTypes={nodeTypes}
                    defaultViewport={{ x: 0, y: 0, zoom: 1 }}
                    minZoom={0.2}
                    maxZoom={2}
                 >
                    <Background color="#e5e7eb" gap={20} size={1} />
                    <Controls className="bg-white border border-gray-200 shadow-sm rounded-lg p-1" />
                    <MiniMap className="border border-gray-200 rounded-lg shadow-sm" zoomable pannable />
                    <Panel position="top-left" className="bg-white/80 backdrop-blur p-2 rounded-lg border border-gray-200 text-xs text-gray-500 shadow-sm">
                        Total Steps: {nodes.length}
                    </Panel>
                 </ReactFlow>
            </div>

            {/* SIDEBAR TOOLBOX */}
            <div className="w-72 bg-white border-l border-gray-200 flex flex-col shadow-xl z-10">
                <div className="p-4 border-b border-gray-100">
                    <h3 className="text-xs font-bold text-gray-900 uppercase tracking-wider flex items-center gap-2">
                        <GripVertical size={14} /> Toolbox
                    </h3>
                </div>
                
                <div className="flex-1 overflow-y-auto p-4 space-y-6">
                    
                    {/* Section: Messages */}
                    <div>
                        <h4 className="text-[10px] font-bold text-gray-400 uppercase mb-3 px-1">Send Message</h4>
                        <div className="grid grid-cols-2 gap-2">
                             <DraggableItem type="custom" inputType="text" label="Text Msg" icon={<MessageSquare size={16} />} />
                             <DraggableItem type="custom" inputType="text" label="Image" icon={<ImageIcon size={16} />} />
                             <DraggableItem type="custom" inputType="text" label="Template" icon={<Settings2 size={16} />} />
                        </div>
                    </div>

                    {/* Section: Interaction */}
                    <div>
                        <h4 className="text-[10px] font-bold text-gray-400 uppercase mb-3 px-1">Ask User</h4>
                        <div className="space-y-2">
                             <DraggableItem type="custom" inputType="text" label="Collect Input" icon={<Type size={16} />} />
                             <DraggableItem type="custom" inputType="option" label="Buttons / Options" icon={<List size={16} />} />
                        </div>
                    </div>

                    {/* Section: Logic */}
                    <div>
                        <h4 className="text-[10px] font-bold text-gray-400 uppercase mb-3 px-1">Logic</h4>
                        <div className="space-y-2">
                             <div className="opacity-50 cursor-not-allowed border border-dashed border-gray-300 rounded-lg p-3 text-xs text-gray-400 flex items-center gap-2">
                                <Split size={16} /> Conditions (Pro)
                             </div>
                             <div className="opacity-50 cursor-not-allowed border border-dashed border-gray-300 rounded-lg p-3 text-xs text-gray-400 flex items-center gap-2">
                                <Zap size={16} /> Webhook (Pro)
                             </div>
                        </div>
                    </div>

                </div>
                
                <div className="p-4 bg-gray-50 border-t border-gray-100 text-[10px] text-gray-400 text-center">
                    Drag items onto the canvas to add steps.
                </div>
            </div>

        </div>
    </div>
  );
};

// Helper for Sidebar Items
const DraggableItem = ({ type, inputType, label, icon }: any) => {
    const onDragStart = (event: React.DragEvent, nodeType: string) => {
      event.dataTransfer.setData('application/reactflow', nodeType);
      event.dataTransfer.setData('application/inputType', inputType);
      event.dataTransfer.setData('application/label', label);
      event.dataTransfer.effectAllowed = 'move';
    };
  
    return (
      <div 
        className="bg-white border border-gray-200 rounded-lg p-3 cursor-grab hover:border-blue-500 hover:shadow-md transition-all flex items-center gap-3 group"
        onDragStart={(event) => onDragStart(event, type)} 
        draggable
      >
        <div className="text-gray-500 group-hover:text-blue-600 transition-colors">
            {icon}
        </div>
        <span className="text-sm font-medium text-gray-700">{label}</span>
      </div>
    );
};