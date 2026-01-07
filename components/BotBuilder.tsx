
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
  MousePointerClick, Bold, Italic, Link, MoreHorizontal, Upload, Cloud, Stethoscope, Wand2, Terminal, Code,
  FileCode, Layers, Youtube, Eraser, Brush
} from 'lucide-react';

// --- STYLES & CONSTANTS ---
const HANDLE_STYLE = { width: 10, height: 10, background: '#64748b', border: '2px solid white', zIndex: 50 };
const ACTIVE_HANDLE_STYLE = { width: 12, height: 12, background: '#3b82f6', border: '2px solid white', zIndex: 50 };
const PLACEHOLDER_TEXTS = ['replace this sample message', 'enter your message', 'type your message here', 'replace this text'];

// --- CUSTOM NODE COMPONENT ---
const CustomNode = ({ data, id, selected }: any) => {
  const updateNodeData = useFlowStore((state) => state.updateNodeData);
  const deleteNode = useFlowStore((state) => state.deleteNode);

  const [options, setOptions] = useState<string[]>(data.options || []);
  const [variableName, setVariableName] = useState(data.saveToField || '');
  const [templateName, setTemplateName] = useState(data.templateName || ''); // New State
  const [activeTab, setActiveTab] = useState<'link' | 'upload'>('link'); 

  // Sync internal state with props
  useEffect(() => {
    setOptions(data.options || []);
    setVariableName(data.saveToField || '');
    setTemplateName(data.templateName || '');
  }, [data.options, data.saveToField, data.templateName]);

  const handleChange = (field: string, value: any) => {
    if (field === 'mediaUrl' && typeof value === 'string') {
        value = value.replace(/(https?:\/\/){2,}/g, '$1'); 
    }
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

  const isInputType = ['Text', 'Number', 'Email', 'Website', 'Date', 'Time'].includes(data.label);
  const isMediaType = ['Image', 'Video', 'File', 'Audio'].includes(data.label);
  const isOptionType = ['Quick Reply', 'List'].includes(data.label);
  const hasError = data.hasError;
  const isYouTube = data.mediaUrl && (data.mediaUrl.includes('youtube.com') || data.mediaUrl.includes('youtu.be'));
  
  // Check specifically for the "Replace this..." text
  const hasPlaceholder = data.message && PLACEHOLDER_TEXTS.some(t => data.message.toLowerCase().includes(t));

  // --- START NODE ---
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

  // --- 1. PREVIEW CARD ---
  if (!selected) {
    return (
      <div className={`w-[280px] bg-white rounded-xl shadow-sm border transition-all hover:shadow-md
          ${hasPlaceholder ? 'border-red-500 ring-2 ring-red-100' : (hasError ? 'border-amber-300 bg-amber-50/10' : 'border-gray-200')}
      `}>
          <Handle type="target" position={Position.Left} style={HANDLE_STYLE} className="-left-2.5" />
          
          <div className={`px-4 py-3 flex items-center gap-2 border-b rounded-t-xl ${hasPlaceholder ? 'bg-red-50 border-red-100' : 'bg-gray-50/50 border-gray-100'}`}>
             <div className={`p-1.5 rounded-md ${isMediaType ? 'bg-amber-100 text-amber-600' : isInputType ? 'bg-purple-100 text-purple-600' : 'bg-blue-100 text-blue-600'}`}>
                {data.icon || <MessageSquare size={14} />}
             </div>
             <span className="text-xs font-bold text-gray-700 uppercase tracking-wide">{data.label}</span>
             {hasPlaceholder && <ShieldAlert size={14} className="ml-auto text-red-600 animate-pulse" />}
          </div>

          <div className="p-4">
             {/* Template Warning in Preview */}
             {data.templateName && (
                 <div className="mb-2 bg-blue-50 text-blue-700 px-2 py-1 rounded text-[10px] font-mono border border-blue-100 flex items-center gap-1">
                    <FileCode size={10} /> Tpl: {data.templateName}
                 </div>
             )}

             {isMediaType && (
                <div className="mb-3 relative group overflow-hidden rounded-lg bg-gray-100 border border-gray-200 aspect-video flex items-center justify-center">
                    {data.mediaUrl ? (
                        <div className="text-[10px] text-gray-500">Media Set</div>
                    ) : (
                        <span className="text-[10px] text-gray-400 font-medium">No Media Set</span>
                    )}
                </div>
             )}

             <p className={`text-xs line-clamp-3 ${hasPlaceholder ? 'text-red-600 font-bold' : 'text-gray-600'} ${!data.message && 'italic text-gray-400'}`}>
                {data.message || 'No message text...'}
             </p>

             {isOptionType && options.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                    {options.slice(0, 3).map((opt, i) => (
                        <span key={i} className="text-[10px] bg-gray-100 border border-gray-200 px-2 py-1 rounded-md text-gray-600 font-medium">
                            {opt}
                        </span>
                    ))}
                    {options.length > 3 && <span className="text-[10px] text-gray-400">+{options.length - 3}</span>}
                </div>
             )}
          </div>

          {isOptionType ? (
               <div className="absolute -right-2 top-1/2 -translate-y-1/2 flex flex-col gap-1">
                   {options.map((_, i) => <div key={i} className="w-1 h-1" />)} 
               </div> 
          ) : (
              <Handle type="source" position={Position.Right} id="main" style={HANDLE_STYLE} className="-right-2.5" />
          )}
          
          {isOptionType && options.map((_, idx) => (
             <Handle key={idx} type="source" position={Position.Right} id={`opt_${idx}`} style={{ ...HANDLE_STYLE, top: 'auto', bottom: 'auto', right: -6, marginTop: (idx * 10) }} className="opacity-0" />
          ))}
      </div>
    );
  }

  // --- 2. EDITOR POPUP ---
  return (
    <div className={`w-[400px] bg-white rounded-xl shadow-2xl ring-4 ring-blue-500/20 transition-all duration-200 animate-in fade-in zoom-in-95 z-50`}>
        <Handle type="target" position={Position.Left} style={ACTIVE_HANDLE_STYLE} className="-left-3" />
        
        {hasPlaceholder && (
             <div className="absolute -top-3 right-4 bg-red-600 text-white px-3 py-1 rounded-full shadow-md z-50 flex items-center gap-1.5">
                <ShieldAlert size={12} />
                <span className="text-[10px] font-bold uppercase tracking-wider">Placeholder Detected!</span>
             </div>
        )}

        <div className="px-5 py-4 rounded-t-xl border-b flex items-center justify-between bg-white">
            <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${isMediaType ? 'bg-amber-100 text-amber-600' : isInputType ? 'bg-purple-100 text-purple-600' : 'bg-blue-100 text-blue-600'}`}>
                    {data.icon || <MessageSquare size={18} />}
                </div>
                <div>
                    <h3 className="text-sm font-bold text-gray-900">{data.label} Step</h3>
                    <p className="text-[10px] text-gray-500 font-medium">Configure this interaction</p>
                </div>
            </div>
            <button onClick={() => deleteNode(id)} className="text-gray-400 hover:text-red-500 hover:bg-red-50 p-2 rounded-lg transition-colors">
                <Trash2 size={16} />
            </button>
        </div>

        <div className="p-5 space-y-5 max-h-[400px] overflow-y-auto custom-scrollbar">
            
            {/* MESSAGE INPUT */}
            <div>
                 <div className="flex items-center justify-between mb-1.5">
                    <label className="text-[10px] font-bold text-gray-500 uppercase">Message Text <span className="text-red-500">*</span></label>
                    {hasPlaceholder && (
                        <button 
                            onClick={() => handleChange('message', '')}
                            className="text-[10px] bg-red-100 text-red-600 px-2 py-0.5 rounded border border-red-200 font-bold hover:bg-red-200 transition-colors flex items-center gap-1"
                        >
                            <Eraser size={10} /> Clear Placeholder
                        </button>
                    )}
                 </div>
                 <textarea 
                    className={`w-full bg-gray-50 border rounded-lg p-3 text-sm text-gray-800 outline-none resize-none transition-all min-h-[100px]
                        ${hasPlaceholder 
                            ? 'border-red-500 bg-red-50 focus:border-red-600' 
                            : 'border-gray-200 focus:border-blue-500 focus:bg-white focus:shadow-sm'}
                    `}
                    placeholder="Type the message sent to the user..."
                    value={data.message}
                    onChange={(e) => handleChange('message', e.target.value)}
                 />
            </div>

            {/* OPTIONS (Buttons/List) */}
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

            {/* VARIABLE SAVE */}
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

            {/* TEMPLATE OVERRIDE (CRITICAL FIX) */}
            <div className="bg-blue-50 rounded-lg p-3 border border-blue-100 mt-4">
                <label className="text-[10px] font-bold text-blue-700 uppercase mb-1.5 flex items-center gap-1.5">
                    <FileCode size={12} /> WhatsApp Template ID (Override)
                </label>
                <div className="relative">
                    <input 
                        type="text" 
                        value={templateName}
                        onChange={(e) => {
                            setTemplateName(e.target.value);
                            handleChange('templateName', e.target.value);
                        }}
                        className="w-full bg-white border border-blue-200 text-blue-900 text-xs font-mono rounded-lg pl-3 pr-8 py-2 focus:ring-2 focus:ring-blue-500 outline-none"
                        placeholder="e.g. hello_world"
                    />
                    {templateName && (
                        <button 
                            onClick={() => {
                                setTemplateName('');
                                handleChange('templateName', '');
                            }}
                            className="absolute right-2 top-2 text-gray-400 hover:text-red-500"
                        >
                            <X size={14} />
                        </button>
                    )}
                </div>
                <p className="text-[10px] text-blue-500 mt-1.5 leading-tight">
                    <strong>Warning:</strong> If this is set, WhatsApp ignores the message text above and sends this template from Meta. Clear it if you want to send custom text.
                </p>
            </div>
        </div>
        
        {!isOptionType && (
            <Handle type="source" position={Position.Right} id="main" style={ACTIVE_HANDLE_STYLE} className="-right-3" />
        )}
    </div>
  );
};

const nodeTypes = {
  custom: CustomNode,
};

// ... [DraggableSidebarItem remains unchanged] ...
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
  const [files, setFiles] = useState<Array<{path: string, content: string}>>([]);
  const [issueDescription, setIssueDescription] = useState('Chat flow errors regarding empty options');
  const [doctorDiagnosis, setDoctorDiagnosis] = useState<any>(null);
  const [isAnalyzingCode, setIsAnalyzingCode] = useState(false);
  const [isPatching, setIsPatching] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

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
            setNodes(settings.flowData.nodes);
            setEdges(settings.flowData.edges);
        }
    };
    load();
  }, [isLiveMode, setNodes, setEdges]);

  // Drag & Drop Logic
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
            errorMessage: 'Required',
            templateName: '' // Initialize Empty
        },
      };

      addNode(newNode);
    },
    [reactFlowInstance, addNode],
  );

  // --- ACTIONS ---

  const sanitizeFlow = () => {
      const confirm = window.confirm("This will clear 'Replace this sample message' from ALL nodes. Continue?");
      if(!confirm) return;

      const BLOCKED_REGEX = /replace\s+this\s+sample\s+message|enter\s+your\s+message|type\s+your\s+message\s+here|replace\s+this\s+text/i;
      
      const newNodes = nodes.map(n => {
          let updated = false;
          let newData = { ...n.data };
          
          if (newData.message && BLOCKED_REGEX.test(newData.message)) {
              newData.message = '';
              newData.hasError = true;
              newData.errorMessage = "Empty Message";
              updated = true;
          }
          
          return updated ? { ...n, data: newData } : n;
      });
      
      setNodes(newNodes);
      alert("✅ All placeholders cleared. Please fill in valid messages.");
  };

  const runAIAudit = async () => {
      setIsAuditing(true);
      try {
          let report;
          if (isLiveMode) {
              try {
                  report = await liveApiService.auditFlow(nodes);
              } catch (e) {
                  console.warn("Live Audit Failed. Falling back to local.", e);
                  report = await auditBotFlow(nodes); 
              }
          } else {
              report = await auditBotFlow(nodes);
          }
          
          setAuditReport(report);
          
          if (report.issues.length > 0) {
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
          alert("Audit Failed.");
      } finally {
          setIsAuditing(false);
      }
  };

  const applyFix = (issue: any) => {
      if (issue.autoFixValue === 'DELETE_NODE') {
          deleteNode(issue.nodeId);
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
          setAuditReport((prev: any) => ({
            ...prev,
            issues: prev.issues.filter((i: any) => i.nodeId !== issue.nodeId)
        }));
      }
  };

  // ... [System Doctor Logic remains unchanged] ...
  const openSystemDoctor = async () => {
      if (!isLiveMode) { alert("System Doctor requires Live Mode"); return; }
      setShowSystemDoctor(true);
      try { const res = await liveApiService.getProjectContext(); setFiles(res.files); setDoctorDiagnosis(null); } catch(e) { alert("Could not access project files."); setShowSystemDoctor(false); }
  };
  const analyzeCode = async () => { setIsAnalyzingCode(true); try { const res = await analyzeSystemCode(files, issueDescription); setDoctorDiagnosis(res); if (res.changes?.length > 0) setSelectedFile(res.changes[0].filePath); } catch(e) { alert("Analysis Failed"); } finally { setIsAnalyzingCode(false); } };
  const applySystemPatch = async () => { if (!doctorDiagnosis?.changes) return; setIsPatching(true); try { await liveApiService.applySystemPatch(doctorDiagnosis.changes); alert("✅ Patches Applied!"); setShowSystemDoctor(false); } catch(e) { alert("Failed to patch system"); } finally { setIsPatching(false); } };

  const handleSave = async () => {
      let hasValidationErrors = false;
      
      const newNodes = nodes.map(node => {
          if (node.data.type === 'start') return node;
          
          let error = false;
          let errorMsg = '';
          let { label, message, mediaUrl, inputType, options, templateName } = node.data;
          
          const BLOCKED_REGEX = /replace\s+this\s+sample\s+message|enter\s+your\s+message|type\s+your\s+message\s+here|replace\s+this\s+text/i;
          if (message && BLOCKED_REGEX.test(message)) {
              error = true;
              errorMsg = "Placeholder Detected";
          }

          if ((label === 'Text' || inputType === 'option' || inputType === 'text') && !templateName) {
             if (!message || !message.trim()) {
                 error = true;
                 errorMsg = 'Empty Message';
             }
          }

          if ((label === 'Image' || label === 'Video') && (!mediaUrl || !mediaUrl.trim()) && !templateName) {
              error = true;
              errorMsg = 'Missing URL';
          }

          if (inputType === 'option' && !templateName) {
              if (!options || options.length === 0) {
                  error = true;
                  errorMsg = 'No Options';
              } else if (options.some((o: string) => !o || !o.trim())) {
                  error = true;
                  errorMsg = 'Empty Option Found';
              }
          }

          if (error) hasValidationErrors = true;
          return { ...node, data: { ...node.data, message, hasError: error, errorMessage: errorMsg } };
      });

      if (hasValidationErrors) {
          setNodes(newNodes);
          alert("❌ SAVE BLOCKED: Placeholders detected! Look for RED nodes in the editor.");
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
            mediaUrl: node.data.mediaUrl,
            templateName: node.data.templateName // Include Template Name
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
                 
                 {/* SANITIZE BUTTON */}
                 <button
                    onClick={sanitizeFlow}
                    className="bg-white border border-gray-300 text-gray-700 px-4 py-2.5 rounded-full text-sm font-bold shadow-md hover:bg-gray-50 transition-all flex items-center gap-2"
                 >
                    <Brush size={16} /> Sanitize
                 </button>

                 {isLiveMode && (
                     <button onClick={openSystemDoctor} className="bg-red-600 text-white px-4 py-2.5 rounded-full text-sm font-bold shadow-lg hover:bg-red-700 transition-all flex items-center gap-2">
                        <Code size={16} /> System Doctor
                     </button>
                 )}

                 <button onClick={runAIAudit} disabled={isAuditing} className="bg-purple-600 text-white px-4 py-2.5 rounded-full text-sm font-bold shadow-lg hover:bg-purple-700 transition-all flex items-center gap-2">
                    {isAuditing ? <span className="animate-spin"><Stethoscope size={16} /></span> : <Stethoscope size={16} />}
                    {isAuditing ? 'Diagnosing...' : 'AI Flow Audit'}
                 </button>
                 <button onClick={handleSave} disabled={isSaving} className="bg-black text-white px-5 py-2.5 rounded-full text-sm font-bold shadow-lg hover:bg-gray-800 transition-all flex items-center gap-2">
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
                    <MiniMap className="border border-gray-200 rounded-lg shadow-xl" nodeColor={(n) => n.type === 'start' ? '#10b981' : '#3b82f6'} maskColor="rgba(240, 242, 245, 0.7)" />
                    
                    <Panel position="bottom-center" className="mb-8">
                        <div className="bg-white/90 backdrop-blur border border-gray-200 px-4 py-2 rounded-full text-xs text-gray-500 shadow-sm flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-green-500"></span>
                            Strict Mode Active: Placeholders Blocked
                        </div>
                    </Panel>
                 </ReactFlow>
            </div>
        </div>

        {/* SYSTEM DOCTOR & AUDIT MODALS (Same as before) */}
        {showSystemDoctor && (
             <div className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-md flex items-center justify-center p-6">
                 {/* ... System Doctor Content ... */}
                 <div className="bg-gray-900 w-full max-w-[90vw] h-[90vh] rounded-2xl shadow-2xl overflow-hidden flex flex-col border border-gray-800">
                     <div className="bg-black px-6 py-4 flex justify-between items-center border-b border-gray-800">
                         <div className="flex items-center gap-3">
                             <div className="bg-red-600 p-2 rounded-lg"><Terminal className="text-white" size={20} /></div>
                             <div>
                                 <h2 className="text-white font-mono text-lg font-bold">System Doctor <span className="text-red-500">ULTIMATE</span></h2>
                                 <p className="text-gray-400 text-xs">Full Project Analysis & Patching</p>
                             </div>
                         </div>
                         <button onClick={() => setShowSystemDoctor(false)} className="text-gray-400 hover:text-white"><X size={24} /></button>
                     </div>
                     <div className="flex-1 flex overflow-hidden">
                         <div className="w-1/4 bg-gray-950 border-r border-gray-800 flex flex-col">
                             <div className="p-6 flex-1 overflow-y-auto space-y-6">
                                 <div>
                                     <label className="text-gray-400 text-xs font-bold uppercase mb-2 block">Issue Description</label>
                                     <textarea value={issueDescription} onChange={(e) => setIssueDescription(e.target.value)} className="w-full bg-gray-900 text-white border border-gray-700 rounded-lg p-3 text-sm h-32 focus:ring-2 focus:ring-red-500 outline-none resize-none" placeholder="Describe the bug..." />
                                 </div>
                                 <button onClick={analyzeCode} disabled={isAnalyzingCode} className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-lg flex items-center justify-center gap-2 disabled:opacity-50">
                                     {isAnalyzingCode ? <span className="animate-spin"><Stethoscope /></span> : <Stethoscope />} {isAnalyzingCode ? 'Scanning...' : 'Analyze Project'}
                                 </button>
                                 {doctorDiagnosis && (<div className="bg-gray-900 rounded-xl p-4 border border-gray-800"><h4 className="text-red-400 font-bold mb-2 flex items-center gap-2 text-sm"><AlertTriangle size={14} /> AI Diagnosis</h4><p className="text-gray-300 text-xs leading-relaxed whitespace-pre-wrap">{doctorDiagnosis.diagnosis}</p></div>)}
                             </div>
                             {doctorDiagnosis?.changes && (<div className="p-4 border-t border-gray-800 bg-gray-900"><button onClick={applySystemPatch} disabled={isPatching} className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 rounded-lg flex items-center justify-center gap-2 disabled:opacity-50">{isPatching ? 'Patching...' : `APPLY ${doctorDiagnosis.changes.length} FIXES`}</button></div>)}
                         </div>
                         <div className="w-1/5 bg-gray-900 border-r border-gray-800 flex flex-col">
                             <div className="p-3 bg-gray-950 border-b border-gray-800 font-bold text-gray-500 text-xs uppercase flex items-center gap-2"><Layers size={14} /> Affected Files</div>
                             <div className="flex-1 overflow-y-auto">
                                 {doctorDiagnosis?.changes?.map((change: any, idx: number) => (
                                     <button key={idx} onClick={() => setSelectedFile(change.filePath)} className={`w-full text-left px-4 py-3 border-b border-gray-800 hover:bg-gray-800 transition-colors ${selectedFile === change.filePath ? 'bg-gray-800 border-l-2 border-l-red-500' : ''}`}><div className="flex items-center gap-2 text-sm font-mono text-gray-300"><FileCode size={14} className="text-blue-500" /><span className="truncate">{change.filePath}</span></div></button>
                                 ))}
                             </div>
                         </div>
                         <div className="flex-1 bg-black flex flex-col">
                             <div className="bg-gray-900 px-4 py-2 flex items-center justify-between border-b border-gray-800"><span className="text-gray-400 text-xs font-mono">{selectedFile || 'No file selected'}</span></div>
                             <div className="flex-1 overflow-auto p-0">{selectedFile ? (<pre className="text-xs font-mono text-green-50 p-6 leading-relaxed">{doctorDiagnosis.changes.find((c: any) => c.filePath === selectedFile)?.content}</pre>) : (<div className="h-full flex flex-col items-center justify-center text-gray-700"><Terminal size={48} className="mb-4 opacity-20" /><p>Select a file to view AI proposed code.</p></div>)}</div>
                         </div>
                     </div>
                 </div>
             </div>
        )}

        {/* AI AUDIT REPORT MODAL (Same as before) */}
        {auditReport && auditReport.issues.length > 0 && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
                <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95">
                    <div className="bg-purple-600 text-white p-5 flex items-center justify-between"><h3 className="font-bold flex items-center gap-2 text-lg"><Stethoscope size={20} /> AI Diagnosis Report</h3><button onClick={() => setAuditReport(null)} className="hover:bg-white/20 p-1 rounded-full"><X size={20} /></button></div>
                    <div className="p-6 max-h-[60vh] overflow-y-auto space-y-4">
                        {auditReport.issues.map((issue: any, idx: number) => (
                            <div key={idx} className="border border-gray-200 rounded-xl p-4 bg-gray-50"><h4 className="font-bold text-gray-900 text-sm mb-1">{issue.issue}</h4><p className="text-sm text-gray-600 mb-3">{issue.suggestion}</p><div className="flex items-center gap-2">{issue.autoFixValue === 'DELETE_NODE' ? (<button onClick={() => applyFix(issue)} className="px-3 py-1.5 bg-red-600 text-white text-xs font-bold rounded hover:bg-red-700 flex items-center gap-1"><Trash2 size={12} /> Delete Node</button>) : issue.autoFixValue ? (<button onClick={() => applyFix(issue)} className="px-3 py-1.5 bg-blue-600 text-white text-xs font-bold rounded hover:bg-blue-700 flex items-center gap-1"><Wand2 size={12} /> Apply Fix: "{issue.autoFixValue}"</button>) : null}</div></div>
                        ))}
                    </div>
                    <div className="p-4 border-t border-gray-100 flex gap-3 bg-gray-50"><button onClick={() => setAuditReport(null)} className="flex-1 py-3 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors">Dismiss</button></div>
                </div>
            </div>
        )}
    </div>
  );
};
