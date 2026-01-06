import React, { useState, useCallback, useEffect } from 'react';
import { 
  ReactFlow, 
  MiniMap, 
  Controls, 
  Background, 
  Handle, 
  Position,
  Node,
  ReactFlowProvider,
  useReactFlow,
  Panel
} from '@xyflow/react';
import { BotSettings, BotStep } from '../types';
import { mockBackend } from '../services/mockBackend';
import { liveApiService } from '../services/liveApiService';
import { useFlowStore } from '../services/flowStore'; 
import { auditBotFlow, analyzeSystemCode } from '../services/geminiService';
import { 
  MessageSquare, Image as ImageIcon, Video, FileText, MapPin, 
  List, Type, Hash, Mail, Globe, Calendar, Clock, 
  LayoutGrid, X, Trash2, Zap, CheckCircle, Flag, Play, AlertTriangle, ShieldAlert, GripVertical, Settings,
  MousePointerClick, Bold, Italic, Link, MoreHorizontal, Upload, Cloud, Stethoscope, Wand2, Terminal, Code
} from 'lucide-react';

// --- STYLES & CONSTANTS ---
const HANDLE_STYLE = { width: 10, height: 10, background: '#64748b', border: '2px solid white', zIndex: 50 };
const ACTIVE_HANDLE_STYLE = { width: 12, height: 12, background: '#3b82f6', border: '2px solid white', zIndex: 50 };
const PLACEHOLDER_TEXTS = ['replace this sample message', 'enter your message', 'type your message here'];

// --- CUSTOM NODE COMPONENT ---
const CustomNode = ({ data, id, selected }: any) => {
  const updateNodeData = useFlowStore((state) => state.updateNodeData);
  const deleteNode = useFlowStore((state) => state.deleteNode);

  const [options, setOptions] = useState<string[]>(data.options || []);
  const [variableName, setVariableName] = useState(data.saveToField || '');
  const [activeTab, setActiveTab] = useState<'link' | 'upload'>('link'); // For Media Nodes

  // Sync internal state with props
  useEffect(() => {
    setOptions(data.options || []);
    setVariableName(data.saveToField || '');
  }, [data.options, data.saveToField]);

  const handleChange = (field: string, value: any) => {
    updateNodeData(id, { [field]: value });
  };

  const handleOptionChange = (idx: number, val: string) => {
    const newOpts = [...options];
    newOpts[idx] = val;
    setOptions(newOpts);
    handleChange('options', newOpts);
  };

  const addOption = () => {
    const newOpts = [...options, `Option ${options.length + 1}`];
    setOptions(newOpts);
    handleChange('options', newOpts);
  };

  const removeOption = (idx: number) => {
    const newOpts = options.filter((_, i) => i !== idx);
    setOptions(newOpts);
    handleChange('options', newOpts);
  };

  // --- NODE TYPES IDENTIFICATION ---
  const isInputType = ['Text', 'Number', 'Email', 'Website', 'Date', 'Time'].includes(data.label);
  const isMediaType = ['Image', 'Video', 'File', 'Audio'].includes(data.label);
  const isOptionType = ['Quick Reply', 'List'].includes(data.label);
  const hasError = data.hasError;

  // --- START NODE (Always Simple) ---
  if (data.type === 'start') {
    return (
      <div className={`group relative shadow-md rounded-xl bg-white border-2 transition-all ${selected ? 'border-green-500 ring-4 ring-green-50' : 'border-gray-100'}`}>
        <div className="bg-green-50 px-4 py-2 rounded-t-xl border-b border-green-100 flex items-center gap-2">
           <Flag size={14} className="text-green-600" />
           <span className="text-xs font-bold text-green-800 uppercase tracking-wide">Starting Step</span>
        </div>
        <div className="p-4 flex items-center justify-center">
            <p className="text-sm font-medium text-gray-600">Conversation Begins Here</p>
        </div>
        <Handle type="source" position={Position.Right} style={ACTIVE_HANDLE_STYLE} className="-right-3" />
      </div>
    );
  }

  // --- 1. PREVIEW CARD (UNSELECTED) ---
  if (!selected) {
    return (
      <div className={`w-[280px] bg-white rounded-xl shadow-sm border transition-all hover:shadow-md
          ${hasError ? 'border-red-300 bg-red-50/10' : 'border-gray-200'}
      `}>
          <Handle type="target" position={Position.Left} style={HANDLE_STYLE} className="-left-2.5" />
          
          {/* Header */}
          <div className="px-4 py-3 flex items-center gap-2 border-b border-gray-100 bg-gray-50/50 rounded-t-xl">
             <div className={`p-1.5 rounded-md ${isMediaType ? 'bg-amber-100 text-amber-600' : isInputType ? 'bg-purple-100 text-purple-600' : 'bg-blue-100 text-blue-600'}`}>
                {data.icon || <MessageSquare size={14} />}
             </div>
             <span className="text-xs font-bold text-gray-700 uppercase tracking-wide">{data.label}</span>
             {hasError && <ShieldAlert size={14} className="ml-auto text-red-500" />}
          </div>

          {/* Preview Body */}
          <div className="p-4">
             {/* Media Preview */}
             {isMediaType && (
                <div className="mb-3 relative group overflow-hidden rounded-lg bg-gray-100 border border-gray-200 aspect-video flex items-center justify-center">
                    {data.mediaUrl ? (
                        data.label === 'Image' ? (
                            <img src={data.mediaUrl} alt="Preview" className="w-full h-full object-cover" />
                        ) : data.label === 'Video' ? (
                            <>
                                <div className="absolute inset-0 bg-black/10" />
                                <div className="h-10 w-10 bg-white/90 rounded-full flex items-center justify-center shadow-lg z-10">
                                    <Play size={16} className="text-gray-900 ml-0.5" />
                                </div>
                            </>
                        ) : (
                            <div className="flex flex-col items-center text-gray-400 gap-1">
                                <FileText size={24} />
                                <span className="text-[10px] font-mono">FILE LINK</span>
                            </div>
                        )
                    ) : (
                        <span className="text-[10px] text-gray-400 font-medium">No Media Set</span>
                    )}
                </div>
             )}

             {/* Text Preview */}
             <p className={`text-xs text-gray-600 line-clamp-3 ${!data.message && 'italic text-gray-400'}`}>
                {data.message || 'No message text...'}
             </p>

             {/* Options Preview */}
             {isOptionType && options.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                    {options.slice(0, 3).map((opt, i) => (
                        <span key={i} className={`text-[10px] bg-gray-100 border px-2 py-1 rounded-md text-gray-600 font-medium ${!opt.trim() ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
                            {opt || '⚠ Empty'}
                        </span>
                    ))}
                    {options.length > 3 && <span className="text-[10px] text-gray-400">+{options.length - 3}</span>}
                </div>
             )}
             
             {/* Input Variable Preview */}
             {isInputType && variableName && (
                 <div className="mt-3 flex items-center gap-1.5 text-[10px] text-purple-600 bg-purple-50 px-2 py-1 rounded border border-purple-100 w-fit">
                    <Hash size={10} />
                    <span className="font-mono">{variableName}</span>
                 </div>
             )}
          </div>

          {/* Outlets */}
          {isOptionType ? (
               <div className="absolute -right-2 top-1/2 -translate-y-1/2 flex flex-col gap-1">
                   {options.map((_, i) => <div key={i} className="w-1 h-1" />)} 
                   {/* Ghost spacers for handles alignment logic if needed, simplified here */}
               </div> 
          ) : (
              <Handle type="source" position={Position.Right} id="main" style={HANDLE_STYLE} className="-right-2.5" />
          )}
          
          {/* Specific Handles for Options in Preview Mode (To keep connections visible) */}
          {isOptionType && options.map((_, idx) => (
             <Handle 
                key={idx} 
                type="source" 
                position={Position.Right} 
                id={`opt_${idx}`} 
                style={{ ...HANDLE_STYLE, top: 'auto', bottom: 'auto', right: -6, marginTop: (idx * 10) }} 
                className="opacity-0" // Hidden but functional
             />
          ))}
      </div>
    );
  }

  // --- 2. EDITOR POPUP (SELECTED) ---
  return (
    <div className={`w-[400px] bg-white rounded-xl shadow-2xl ring-4 ring-blue-500/20 transition-all duration-200 animate-in fade-in zoom-in-95 z-50`}>
        <Handle type="target" position={Position.Left} style={ACTIVE_HANDLE_STYLE} className="-left-3" />
        
        {/* Error Flag */}
        {hasError && (
             <div className="absolute -top-3 right-4 bg-red-600 text-white px-3 py-1 rounded-full shadow-md z-50 flex items-center gap-1.5">
                <ShieldAlert size={12} />
                <span className="text-[10px] font-bold uppercase tracking-wider">{data.errorMessage || "Validation Error"}</span>
             </div>
        )}

        {/* Header */}
        <div className={`px-5 py-4 rounded-t-xl border-b flex items-center justify-between bg-white`}>
            <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${isMediaType ? 'bg-amber-100 text-amber-600' : isInputType ? 'bg-purple-100 text-purple-600' : 'bg-blue-100 text-blue-600'}`}>
                    {data.icon || <MessageSquare size={18} />}
                </div>
                <div>
                    <h3 className="text-sm font-bold text-gray-900">{data.label} Step</h3>
                    <p className="text-[10px] text-gray-500 font-medium">Configure this interaction</p>
                </div>
            </div>
            <button onClick={() => deleteNode(id)} className="text-gray-400 hover:text-red-500 hover:bg-red-50 p-2 rounded-lg transition-colors" title="Delete Step">
                <Trash2 size={16} />
            </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-5 max-h-[400px] overflow-y-auto custom-scrollbar">
            
            {/* 1. TEXT TOOLBAR (Text Nodes) */}
            {(data.label === 'Text' || isInputType) && (
                <div className="flex items-center gap-1 pb-2 border-b border-gray-100 mb-2">
                    <button className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded"><Bold size={14} /></button>
                    <button className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded"><Italic size={14} /></button>
                    <div className="w-px h-4 bg-gray-200 mx-1" />
                    <button className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded"><Link size={14} /></button>
                    <button className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded ml-auto"><MoreHorizontal size={14} /></button>
                </div>
            )}

            {/* 2. MEDIA TABS (Image/Video) */}
            {isMediaType && (
                <div>
                     <div className="flex p-1 bg-gray-100 rounded-lg mb-3">
                         <button 
                            onClick={() => setActiveTab('link')}
                            className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-[10px] font-bold uppercase rounded-md transition-all ${activeTab === 'link' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                         >
                            <Link size={12} /> URL Link
                         </button>
                         <button 
                            onClick={() => setActiveTab('upload')}
                            className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-[10px] font-bold uppercase rounded-md transition-all ${activeTab === 'upload' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                         >
                            <Upload size={12} /> Upload
                         </button>
                     </div>

                     {activeTab === 'link' ? (
                        <div>
                            <label className="text-[10px] font-bold text-gray-500 uppercase mb-1.5 block">File URL <span className="text-red-500">*</span></label>
                            <input 
                                type="text" 
                                className={`w-full bg-gray-50 border rounded-lg px-3 py-2.5 text-xs text-gray-700 outline-none transition-all ${hasError && !data.mediaUrl ? 'border-red-300 bg-red-50' : 'border-gray-200 focus:border-blue-500'}`}
                                placeholder={`https://example.com/media.mp4`}
                                value={data.mediaUrl || ''}
                                onChange={(e) => handleChange('mediaUrl', e.target.value)}
                            />
                        </div>
                     ) : (
                        <div className="border-2 border-dashed border-gray-200 rounded-lg p-6 flex flex-col items-center justify-center text-gray-400 bg-gray-50 hover:bg-gray-100 hover:border-gray-300 transition-all cursor-pointer">
                            <Cloud size={24} className="mb-2" />
                            <span className="text-xs font-medium">Click to upload file</span>
                        </div>
                     )}
                </div>
            )}

            {/* 3. MESSAGE INPUT */}
            <div>
                 <label className="text-[10px] font-bold text-gray-500 uppercase mb-1.5 block">
                    {isInputType ? "Question / Prompt" : "Message Text"} <span className="text-red-500">*</span>
                 </label>
                 <textarea 
                    className={`w-full bg-gray-50 border rounded-lg p-3 text-sm text-gray-800 outline-none resize-none transition-all min-h-[100px]
                        ${hasError && (!data.message || PLACEHOLDER_TEXTS.some(t => data.message?.toLowerCase().includes(t))) 
                            ? 'border-red-300 bg-red-50 focus:border-red-500' 
                            : 'border-gray-200 focus:border-blue-500 focus:bg-white focus:shadow-sm'}
                    `}
                    placeholder="Type the message sent to the user..."
                    value={data.message}
                    onChange={(e) => handleChange('message', e.target.value)}
                 />
                 {hasError && data.message && PLACEHOLDER_TEXTS.some(t => data.message.toLowerCase().includes(t)) && (
                     <p className="text-[10px] text-red-500 mt-1.5 font-bold flex items-center gap-1"><AlertTriangle size={10} /> Placeholder text detected</p>
                 )}
            </div>

            {/* 4. OPTIONS (Buttons/List) */}
            {isOptionType && (
                <div>
                    <label className="text-[10px] font-bold text-gray-500 uppercase mb-2 block flex items-center justify-between">
                        <span>Response Options</span>
                        <span className="text-xs font-normal text-gray-400">{options.length} items</span>
                    </label>
                    <div className="space-y-2 mb-3">
                        {options.map((opt, idx) => (
                            <div key={idx} className="flex items-center gap-2 group">
                                <div className={`flex-1 flex items-center bg-gray-50 border rounded-lg pl-3 pr-1 py-1.5 focus-within:ring-1 focus-within:ring-blue-500 focus-within:bg-white transition-all shadow-sm ${!opt.trim() ? 'border-red-300 ring-1 ring-red-100' : 'border-gray-200'}`}>
                                    <span className="text-[10px] text-gray-400 mr-2 font-mono flex items-center justify-center w-4 h-4 rounded bg-gray-200">{idx + 1}</span>
                                    <input 
                                        value={opt}
                                        onChange={(e) => handleOptionChange(idx, e.target.value)}
                                        className="flex-1 bg-transparent border-none p-0 text-xs text-gray-700 outline-none font-medium"
                                        placeholder={`Option ${idx + 1}`}
                                    />
                                    <button onClick={() => removeOption(idx)} className="p-1 text-gray-300 hover:text-red-500 rounded hover:bg-red-50 transition-colors">
                                        <X size={14} />
                                    </button>
                                </div>
                                <div className="flex items-center gap-1">
                                    <span className="text-[10px] text-gray-400">→</span>
                                    <Handle type="source" position={Position.Right} id={`opt_${idx}`} style={{...ACTIVE_HANDLE_STYLE, position: 'relative', transform: 'none', right: 0}} />
                                </div>
                            </div>
                        ))}
                    </div>
                    <button 
                        onClick={addOption}
                        className="w-full py-2.5 border border-dashed border-gray-300 rounded-lg text-xs font-bold text-gray-500 hover:text-blue-600 hover:border-blue-400 hover:bg-blue-50 transition-all flex items-center justify-center gap-1.5"
                     >
                        <MousePointerClick size={14} /> Add Button Option
                     </button>
                </div>
            )}

            {/* 5. VARIABLE SAVE (Input) */}
            {isInputType && (
                 <div className="bg-purple-50 rounded-lg p-3 border border-purple-100">
                    <label className="text-[10px] font-bold text-purple-700 uppercase mb-1.5 flex items-center gap-1.5">
                        <Hash size={12} /> Save Response To
                    </label>
                    <select 
                        value={variableName}
                        onChange={(e) => {
                            setVariableName(e.target.value);
                            handleChange('saveToField', e.target.value);
                        }}
                        className="w-full bg-white border border-purple-200 text-purple-900 text-xs font-medium rounded-lg px-3 py-2 focus:ring-2 focus:ring-purple-500 outline-none cursor-pointer shadow-sm"
                    >
                        <option value="">-- Do not save --</option>
                        <option value="name">user_name</option>
                        <option value="vehicleRegistration">vehicle_number</option>
                        <option value="availability">availability_status</option>
                        <option value="document">uploaded_document_url</option>
                        <option value="email">email_address</option>
                        <option value="phone">phone_number</option>
                    </select>
                </div>
            )}
        </div>
        
        {/* Main Outlet for non-branching nodes */}
        {!isOptionType && (
            <Handle type="source" position={Position.Right} id="main" style={ACTIVE_HANDLE_STYLE} className="-right-3" />
        )}
    </div>
  );
};

const nodeTypes = {
  custom: CustomNode,
};

// --- DRAGGABLE COMPONENT ---
const DraggableSidebarItem = ({ type, inputType, label, icon }: any) => {
    const onDragStart = (event: React.DragEvent) => {
      event.dataTransfer.setData('application/reactflow/type', type);
      event.dataTransfer.setData('application/reactflow/inputType', inputType);
      event.dataTransfer.setData('application/reactflow/label', label);
      event.dataTransfer.effectAllowed = 'move';
    };
  
    return (
      <div 
        className="bg-white border border-gray-200 rounded-xl px-4 py-3 cursor-grab hover:shadow-md hover:border-blue-300 hover:bg-blue-50/50 transition-all flex items-center gap-3 group" 
        onDragStart={onDragStart} 
        draggable
      >
        <div className="p-2 bg-gray-100 rounded-lg text-gray-500 group-hover:bg-blue-100 group-hover:text-blue-600 transition-colors">
            {icon}
        </div>
        <span className="text-sm font-medium text-gray-700 group-hover:text-blue-800">{label}</span>
        <GripVertical size={14} className="ml-auto text-gray-300" />
      </div>
    );
};

// --- MAIN BUILDER ---

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
  const { 
      nodes, edges, onNodesChange, onEdgesChange, onConnect, 
      setNodes, setEdges, addNode, updateNodeData, deleteNode
  } = useFlowStore();
  
  const [isSaving, setIsSaving] = useState(false);
  const [isAuditing, setIsAuditing] = useState(false);
  const [auditReport, setAuditReport] = useState<any>(null);
  
  // SYSTEM DOCTOR STATES
  const [showSystemDoctor, setShowSystemDoctor] = useState(false);
  const [sourceCode, setSourceCode] = useState('');
  const [issueDescription, setIssueDescription] = useState('Chat flow errors regarding empty options');
  const [doctorDiagnosis, setDoctorDiagnosis] = useState<any>(null);
  const [isAnalyzingCode, setIsAnalyzingCode] = useState(false);
  const [isPatching, setIsPatching] = useState(false);

  const reactFlowInstance = useReactFlow();

  // Load Data
  useEffect(() => {
    const load = async () => {
        let settings: BotSettings;
        if (isLiveMode) {
             try { settings = await liveApiService.getBotSettings(); } catch(e) { return; }
        } else {
             settings = mockBackend.getBotSettings();
        }

        if (settings.flowData && settings.flowData.nodes.length > 0) {
            // Auto-clean placeholders on load
            const cleanedNodes = settings.flowData.nodes.map((n: any) => {
                const newData = { ...n.data };
                const BLOCKED_REGEX = /replace\s+this\s+sample\s+message|enter\s+your\s+message|type\s+your\s+message\s+here|replace\s+this\s+text/i;
                if (newData.message && BLOCKED_REGEX.test(newData.message)) {
                    newData.message = ""; 
                    newData.hasError = true;
                    newData.errorMessage = "Placeholder Removed";
                }
                return { ...n, data: newData };
            });

            setNodes(cleanedNodes);
            setEdges(settings.flowData.edges);
        }
    };
    load();
  }, [isLiveMode, setNodes, setEdges]);

  // Drag & Drop
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/reactflow/type');
      const inputType = event.dataTransfer.getData('application/reactflow/inputType');
      const label = event.dataTransfer.getData('application/reactflow/label');

      if (!type) return;

      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const newNode: Node = {
        id: `node_${Date.now()}`,
        type: 'custom',
        position,
        data: { 
            label: label,
            message: '', 
            inputType: inputType || 'text', 
            icon: undefined, 
            options: inputType === 'option' ? ['Yes', 'No'] : undefined,
            hasError: true,
            errorMessage: 'Required'
        },
      };

      addNode(newNode);
    },
    [reactFlowInstance, addNode],
  );

  const runAIAudit = async () => {
      setIsAuditing(true);
      try {
          const report = await auditBotFlow(nodes);
          setAuditReport(report);
          
          if (report.issues.length > 0) {
              // Highlight faulty nodes
              const badNodeIds = report.issues.map((i: any) => i.nodeId);
              const newNodes = nodes.map(n => {
                  if (badNodeIds.includes(n.id)) {
                      return { 
                          ...n, 
                          data: { 
                              ...n.data, 
                              hasError: true, 
                              errorMessage: "AI Flagged" 
                          } 
                      };
                  }
                  return n;
              });
              setNodes(newNodes);
          }
      } catch (e) {
          alert("AI Audit Failed");
      } finally {
          setIsAuditing(false);
      }
  };

  const applyFix = (issue: any) => {
      if (issue.autoFixValue === 'DELETE_NODE') {
          deleteNode(issue.nodeId);
          // Update report UI by removing the issue
          setAuditReport((prev: any) => ({
              ...prev,
              issues: prev.issues.filter((i: any) => i.nodeId !== issue.nodeId)
          }));
      } else if (issue.autoFixValue) {
          const newNodes = nodes.map(n => {
              if (n.id === issue.nodeId) {
                  return {
                      ...n,
                      data: {
                          ...n.data,
                          message: issue.autoFixValue,
                          hasError: false,
                          errorMessage: undefined
                      }
                  };
              }
              return n;
          });
          setNodes(newNodes);
          // Remove from report
          setAuditReport((prev: any) => ({
            ...prev,
            issues: prev.issues.filter((i: any) => i.nodeId !== issue.nodeId)
        }));
      }
  };

  const openSystemDoctor = async () => {
      if (!isLiveMode) {
          alert("System Doctor requires Live Mode (node server.js)");
          return;
      }
      setShowSystemDoctor(true);
      try {
          const res = await liveApiService.getSourceCode();
          setSourceCode(res.code);
      } catch(e) {
          alert("Could not access server source code.");
          setShowSystemDoctor(false);
      }
  };

  const analyzeCode = async () => {
      setIsAnalyzingCode(true);
      try {
          const res = await analyzeSystemCode(sourceCode, issueDescription);
          setDoctorDiagnosis(res);
      } catch(e) {
          alert("Analysis Failed");
      } finally {
          setIsAnalyzingCode(false);
      }
  };

  const applySystemPatch = async () => {
      if (!doctorDiagnosis) return;
      setIsPatching(true);
      try {
          await liveApiService.applySystemPatch(doctorDiagnosis.fixedCode);
          alert("Patch Applied! Server is restarting...");
          setShowSystemDoctor(false);
      } catch(e) {
          alert("Failed to patch system");
      } finally {
          setIsPatching(false);
      }
  };

  const handleSave = async () => {
      let hasValidationErrors = false;
      
      const newNodes = nodes.map(node => {
          if (node.data.type === 'start') return node;
          
          let error = false;
          let errorMsg = '';
          const { label, message, mediaUrl, inputType, options } = node.data;
          
          if (label === 'Text' || inputType === 'option' || inputType === 'text') {
             const BLOCKED_REGEX = /replace\s+this\s+sample\s+message|enter\s+your\s+message|type\s+your\s+message\s+here|replace\s+this\s+text/i;
             if (!message || !message.trim()) {
                 error = true;
                 errorMsg = 'Empty Message';
             } else if (BLOCKED_REGEX.test(message)) {
                 error = true;
                 errorMsg = 'Placeholder Detected';
             }
          }

          if ((label === 'Image' || label === 'Video') && (!mediaUrl || !mediaUrl.trim())) {
              error = true;
              errorMsg = 'Missing URL';
          }

          if (inputType === 'option') {
              if (!options || options.length === 0) {
                  error = true;
                  errorMsg = 'No Options';
              } else if (options.some((o: string) => !o || !o.trim())) {
                  error = true;
                  errorMsg = 'Empty Option Found';
              }
          }

          if (error) hasValidationErrors = true;
          return { ...node, data: { ...node.data, hasError: error, errorMessage: errorMsg } };
      });

      if (hasValidationErrors) {
          setNodes(newNodes);
          alert("❌ SAVE BLOCKED: Strict Validation Failed.\n\nPlease fix red nodes (Empty Text or Options).");
          return;
      }

      setIsSaving(true);
      
      const compiledSteps: BotStep[] = [];
      nodes.forEach(node => {
          if (node.data.type === 'start') return;
          const outgoingEdges = edges.filter(e => e.source === node.id);
          let nextStepId = 'END';
          if (outgoingEdges.length > 0) nextStepId = outgoingEdges[0].target;

          compiledSteps.push({
            id: node.id,
            title: node.data.label,
            message: node.data.message,
            inputType: node.data.inputType,
            options: node.data.options,
            saveToField: node.data.saveToField,
            nextStepId: nextStepId,
            mediaUrl: node.data.mediaUrl
          });
      });

      const newSettings: BotSettings = {
          ...mockBackend.getBotSettings(),
          steps: compiledSteps,
          flowData: { nodes, edges } 
      };

      try {
          if (isLiveMode) await liveApiService.saveBotSettings(newSettings);
          else mockBackend.updateBotSettings(newSettings);
      } catch(e) {
          alert("Save Failed");
      }
      
      setTimeout(() => setIsSaving(false), 500);
  };

  return (
    <div className="flex h-full bg-gray-50 font-sans relative">
        {/* SIDEBAR */}
        <div className="w-72 bg-white border-r border-gray-200 flex flex-col z-10 shadow-lg">
            <div className="p-5 border-b border-gray-100">
                <div className="flex items-center gap-2 mb-1">
                    <Zap className="text-yellow-500 fill-yellow-500" size={20} />
                    <h2 className="font-bold text-gray-900">Flow Builder</h2>
                </div>
                <p className="text-xs text-gray-500">Drag nodes to canvas</p>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-6">
                <div>
                    <h4 className="text-xs font-bold text-gray-400 uppercase mb-3 tracking-wider">Messaging</h4>
                    <div className="space-y-2">
                        <DraggableSidebarItem type="text" label="Text Message" icon={<MessageSquare size={16} />} />
                        <DraggableSidebarItem type="image" label="Image" icon={<ImageIcon size={16} />} />
                        <DraggableSidebarItem type="video" label="Video" icon={<Video size={16} />} />
                    </div>
                </div>

                <div>
                    <h4 className="text-xs font-bold text-gray-400 uppercase mb-3 tracking-wider">Questions</h4>
                    <div className="space-y-2">
                        <DraggableSidebarItem type="option" inputType="option" label="Buttons / List" icon={<List size={16} />} />
                        <DraggableSidebarItem type="input" inputType="text" label="Collect Text" icon={<Type size={16} />} />
                        <DraggableSidebarItem type="input" inputType="text" label="Collect Number" icon={<Hash size={16} />} />
                    </div>
                </div>
            </div>
        </div>

        {/* CANVAS */}
        <div className="flex-1 relative flex flex-col h-full overflow-hidden">
            <div className="absolute top-4 right-4 z-20 flex gap-3">
                 {/* SYSTEM DOCTOR BUTTON */}
                 {isLiveMode && (
                     <button
                        onClick={openSystemDoctor}
                        className="bg-red-600 text-white px-4 py-2.5 rounded-full text-sm font-bold shadow-lg hover:bg-red-700 transition-all flex items-center gap-2"
                     >
                        <Code size={16} /> System Doctor
                     </button>
                 )}

                 <button 
                    onClick={runAIAudit}
                    disabled={isAuditing}
                    className="bg-purple-600 text-white px-4 py-2.5 rounded-full text-sm font-bold shadow-lg hover:bg-purple-700 transition-all flex items-center gap-2"
                 >
                    {isAuditing ? <span className="animate-spin"><Stethoscope size={16} /></span> : <Stethoscope size={16} />}
                    {isAuditing ? 'Diagnosing...' : 'AI Flow Audit'}
                 </button>
                 <button 
                    onClick={handleSave}
                    disabled={isSaving}
                    className="bg-black text-white px-5 py-2.5 rounded-full text-sm font-bold shadow-lg hover:bg-gray-800 transition-all flex items-center gap-2"
                 >
                    {isSaving ? <span className="animate-spin"><Zap size={16} /></span> : <CheckCircle size={16} />}
                    {isSaving ? 'Validating...' : 'Publish Flow'}
                 </button>
            </div>

            <div className="flex-1 h-full bg-slate-50" onDragOver={onDragOver} onDrop={onDrop}>
                 <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    nodeTypes={nodeTypes}
                    defaultViewport={{ x: 0, y: 0, zoom: 0.8 }}
                    minZoom={0.2}
                    maxZoom={1.5}
                    attributionPosition="bottom-right"
                    proOptions={{ hideAttribution: true }}
                 >
                    <Background color="#cbd5e1" gap={20} size={1} variant="dots" />
                    <Controls className="bg-white border border-gray-200 shadow-xl rounded-lg p-1" />
                    <MiniMap 
                        className="border border-gray-200 rounded-lg shadow-xl" 
                        nodeColor={(n) => n.type === 'start' ? '#10b981' : '#3b82f6'} 
                        maskColor="rgba(240, 242, 245, 0.7)"
                    />
                    
                    <Panel position="bottom-center" className="mb-8">
                        <div className="bg-white/90 backdrop-blur border border-gray-200 px-4 py-2 rounded-full text-xs text-gray-500 shadow-sm flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-green-500"></span>
                            Strict Mode Active: Placeholders Blocked
                        </div>
                    </Panel>
                 </ReactFlow>
            </div>
        </div>

        {/* SYSTEM DOCTOR MODAL (Same as before but uses fixed parsing) */}
        {showSystemDoctor && (
             <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-md flex items-center justify-center p-6">
                 <div className="bg-gray-900 w-full max-w-6xl h-[85vh] rounded-2xl shadow-2xl overflow-hidden flex flex-col border border-gray-800">
                     
                     {/* Header */}
                     <div className="bg-black px-6 py-4 flex justify-between items-center border-b border-gray-800">
                         <div className="flex items-center gap-3">
                             <div className="bg-red-600 p-2 rounded-lg"><Terminal className="text-white" size={20} /></div>
                             <div>
                                 <h2 className="text-white font-mono text-lg font-bold">System Doctor <span className="text-red-500">PRO</span></h2>
                                 <p className="text-gray-400 text-xs">Self-Healing Backend Diagnostics</p>
                             </div>
                         </div>
                         <button onClick={() => setShowSystemDoctor(false)} className="text-gray-400 hover:text-white"><X size={24} /></button>
                     </div>

                     <div className="flex-1 flex overflow-hidden">
                         
                         {/* Left: Configuration & Prompt */}
                         <div className="w-1/3 bg-gray-900 p-6 border-r border-gray-800 flex flex-col gap-6 overflow-y-auto">
                             <div>
                                 <label className="text-gray-400 text-xs font-bold uppercase mb-2 block">Issue Description</label>
                                 <textarea 
                                     value={issueDescription}
                                     onChange={(e) => setIssueDescription(e.target.value)}
                                     className="w-full bg-gray-800 text-white border border-gray-700 rounded-lg p-3 text-sm h-32 focus:ring-2 focus:ring-red-500 outline-none"
                                     placeholder="Describe the bug..."
                                 />
                             </div>

                             <button 
                                onClick={analyzeCode}
                                disabled={isAnalyzingCode}
                                className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-lg flex items-center justify-center gap-2 disabled:opacity-50"
                             >
                                 {isAnalyzingCode ? <span className="animate-spin"><Stethoscope /></span> : <Stethoscope />}
                                 Analyze Source Code
                             </button>

                             {doctorDiagnosis && (
                                 <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
                                     <h4 className="text-red-400 font-bold mb-2 flex items-center gap-2"><AlertTriangle size={16} /> Diagnosis</h4>
                                     <p className="text-gray-300 text-sm leading-relaxed">{doctorDiagnosis.diagnosis}</p>
                                 </div>
                             )}

                             {doctorDiagnosis && (
                                 <div className="mt-auto">
                                     <button 
                                        onClick={applySystemPatch}
                                        disabled={isPatching}
                                        className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 rounded-lg flex items-center justify-center gap-2 disabled:opacity-50"
                                     >
                                         {isPatching ? 'Patching...' : 'APPLY FIX & RESTART SERVER'}
                                     </button>
                                     <p className="text-gray-500 text-xs text-center mt-2">Server will restart automatically.</p>
                                 </div>
                             )}
                         </div>

                         {/* Right: Code Diff View */}
                         <div className="w-2/3 bg-black p-0 flex flex-col">
                             <div className="bg-gray-800 px-4 py-2 flex items-center justify-between">
                                 <span className="text-gray-400 text-xs font-mono">server.js</span>
                                 <div className="flex gap-4 text-xs font-bold">
                                     <span className="text-red-400">Current</span>
                                     <span className="text-green-400">Proposed</span>
                                 </div>
                             </div>
                             
                             <div className="flex-1 flex overflow-hidden font-mono text-xs">
                                 {/* Current Code */}
                                 <div className="flex-1 bg-[#1e1e1e] text-gray-400 p-4 overflow-auto border-r border-gray-700">
                                     <pre>{sourceCode}</pre>
                                 </div>
                                 {/* Proposed Code */}
                                 <div className="flex-1 bg-[#1e1e1e] text-green-100 p-4 overflow-auto relative">
                                     {doctorDiagnosis ? (
                                         <pre>{doctorDiagnosis.fixedCode}</pre>
                                     ) : (
                                         <div className="absolute inset-0 flex items-center justify-center text-gray-600">
                                             Waiting for analysis...
                                         </div>
                                     )}
                                 </div>
                             </div>
                         </div>
                     </div>
                 </div>
             </div>
        )}

        {/* AI AUDIT REPORT MODAL */}
        {auditReport && auditReport.issues.length > 0 && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
                <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95">
                    <div className="bg-purple-600 text-white p-5 flex items-center justify-between">
                        <h3 className="font-bold flex items-center gap-2 text-lg">
                            <Stethoscope size={20} /> AI Diagnosis Report
                        </h3>
                        <button onClick={() => setAuditReport(null)} className="hover:bg-white/20 p-1 rounded-full"><X size={20} /></button>
                    </div>
                    
                    <div className="p-6 max-h-[60vh] overflow-y-auto space-y-4">
                        <div className="bg-purple-50 text-purple-800 p-3 rounded-lg text-sm border border-purple-100 flex items-center gap-2">
                             <AlertTriangle size={16} />
                             Found {auditReport.issues.length} potential issues.
                        </div>

                        {auditReport.issues.map((issue: any, idx: number) => (
                            <div key={idx} className="border border-gray-200 rounded-xl p-4 bg-gray-50">
                                <div className="flex items-start justify-between mb-2">
                                    <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">Node ID: {issue.nodeId}</span>
                                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${issue.severity === 'CRITICAL' ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-600'}`}>
                                        {issue.severity}
                                    </span>
                                </div>
                                <h4 className="font-bold text-gray-900 text-sm mb-1">{issue.issue}</h4>
                                <p className="text-sm text-gray-600 mb-3">{issue.suggestion}</p>
                                
                                <div className="flex items-center gap-2">
                                    {issue.autoFixValue === 'DELETE_NODE' ? (
                                        <button 
                                            onClick={() => applyFix(issue)}
                                            className="px-3 py-1.5 bg-red-600 text-white text-xs font-bold rounded hover:bg-red-700 flex items-center gap-1"
                                        >
                                            <Trash2 size={12} /> Delete Node
                                        </button>
                                    ) : issue.autoFixValue ? (
                                        <button 
                                            onClick={() => applyFix(issue)}
                                            className="px-3 py-1.5 bg-blue-600 text-white text-xs font-bold rounded hover:bg-blue-700 flex items-center gap-1"
                                        >
                                            <Wand2 size={12} /> Apply Fix: "{issue.autoFixValue}"
                                        </button>
                                    ) : null}
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="p-4 border-t border-gray-100 flex gap-3 bg-gray-50">
                        <button 
                           onClick={() => setAuditReport(null)}
                           className="flex-1 py-3 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors"
                        >
                           Dismiss
                        </button>
                    </div>
                </div>
            </div>
        )}
    </div>
  );
};
