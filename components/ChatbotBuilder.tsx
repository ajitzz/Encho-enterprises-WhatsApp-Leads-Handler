import React, { useCallback, useMemo } from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Connection,
  Controls,
  Edge,
  Handle,
  Node,
  NodeProps,
  Position,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Plus, Save, Sparkles } from "lucide-react";
import Sidebar, { SidebarItem } from "./Sidebar";

interface ChatNodeData {
  label: string;
  subtype: string;
  message: string;
  options?: string[];
  onChange: (id: string, updates: Partial<ChatNodeData>) => void;
  onAddOption?: (id: string) => void;
}

const ChatNode: React.FC<NodeProps<ChatNodeData>> = ({ id, data }) => {
  const isList = data.subtype === "Button List";
  const options = data.options ?? [];

  return (
    <div className="min-w-[260px] rounded-xl border border-slate-200 bg-white p-4 shadow-lg">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{data.subtype}</p>
          <p className="text-lg font-semibold text-slate-800">{data.label}</p>
        </div>
        <Sparkles className="h-5 w-5 text-indigo-500" />
      </div>

      <div className="mt-3 space-y-2">
        <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Message</label>
        <textarea
          value={data.message}
          onChange={(event) => data.onChange(id, { message: event.target.value })}
          placeholder="Type the message that will be sent..."
          className="w-full rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800 shadow-inner focus:border-indigo-500 focus:outline-none"
          rows={3}
        />
      </div>

      {isList && (
        <div className="mt-4">
          <div className="flex items-center justify-between text-sm font-semibold text-slate-700">
            <span>Options</span>
            <button
              type="button"
              onClick={() => data.onAddOption?.(id)}
              className="flex items-center gap-2 rounded-md bg-indigo-50 px-2 py-1 text-xs font-semibold text-indigo-600 transition hover:bg-indigo-100"
            >
              <Plus className="h-4 w-4" /> Add Option
            </button>
          </div>
          <div className="mt-2 space-y-2">
            {options.map((option, index) => (
              <input
                key={`${id}-option-${index}`}
                value={option}
                onChange={(event) => {
                  const updated = [...options];
                  updated[index] = event.target.value;
                  data.onChange(id, { options: updated });
                }}
                placeholder={`Option ${index + 1}`}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-indigo-500 focus:outline-none"
              />
            ))}
          </div>
        </div>
      )}

      <Handle
        type="target"
        position={Position.Left}
        className="!-left-3 h-3 w-3 rounded-full border-2 border-white bg-indigo-500"
      />

      {!isList && (
        <Handle
          type="source"
          position={Position.Right}
          id="default"
          className="!-right-3 h-3 w-3 rounded-full border-2 border-white bg-emerald-500"
        />
      )}

      {isList && options.map((option, index) => (
        <Handle
          key={`${id}-option-handle-${index}`}
          type="source"
          position={Position.Right}
          id={`option-${index}`}
          className="!-right-3 h-3 w-3 rounded-full border-2 border-white bg-emerald-500"
          style={{ top: 110 + index * 40 }}
        />
      ))}
    </div>
  );
};

const ChatbotBuilderCanvas: React.FC = () => {
  const [nodes, setNodes, onNodesChange] = useNodesState<ChatNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const { screenToFlowPosition } = useReactFlow();

  const onConnect = useCallback(
    (params: Edge | Connection) => setEdges((eds) => addEdge({ ...params, animated: true }, eds)),
    [setEdges]
  );

  const updateNodeData = useCallback(
    (id: string, updates: Partial<ChatNodeData>) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === id
            ? {
                ...node,
                data: { ...node.data, ...updates },
              }
            : node
        )
      );
    },
    [setNodes]
  );

  const addListOption = useCallback(
    (id: string) => {
      setNodes((current) =>
        current.map((node) => {
          if (node.id !== id) return node;
          const existingOptions = node.data.options ?? [];
          return {
            ...node,
            data: {
              ...node.data,
              options: [...existingOptions, `Option ${existingOptions.length + 1}`],
            },
          };
        })
      );
    },
    [setNodes]
  );

  const nodeTypes = useMemo(() => ({ chatNode: ChatNode }), []);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const raw = event.dataTransfer.getData("application/reactflow");
      if (!raw) return;
      const item: SidebarItem = JSON.parse(raw);

      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const id = `${item.type}-${item.subtype}-${Date.now()}`;
      const newNode: Node<ChatNodeData> = {
        id,
        type: "chatNode",
        position,
        data: {
          label: item.label,
          subtype: item.subtype,
          message: "",
          options: item.subtype === "Button List" ? ["Option 1"] : [],
          onChange: updateNodeData,
          onAddOption: addListOption,
        },
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [addListOption, screenToFlowPosition, setNodes, updateNodeData]
  );

  const handleSave = useCallback(() => {
    const payload = { nodes, edges };
    // eslint-disable-next-line no-console
    console.log("Flow saved", payload);
  }, [edges, nodes]);

  return (
    <div className="grid h-full grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
      <div className="relative flex h-[calc(100vh-5rem)] flex-col overflow-hidden rounded-xl border border-slate-200 bg-slate-50 shadow-lg">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onDrop={onDrop}
          onDragOver={onDragOver}
          nodeTypes={nodeTypes}
          fitView
          className="bg-slate-50"
        >
          <Background color="#e2e8f0" variant={BackgroundVariant.Dots} gap={16} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      <Sidebar
        onDragStart={(event, node) => {
          event.dataTransfer.setData("application/reactflow", JSON.stringify(node));
          event.dataTransfer.effectAllowed = "move";
        }}
      />

      <div className="absolute left-6 right-6 top-4 z-10 flex items-center justify-between rounded-xl border border-slate-200 bg-white/90 px-4 py-3 shadow-lg backdrop-blur">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Automation Builder</p>
          <h1 className="text-2xl font-bold text-slate-900">Chatbot Flow Editor</h1>
        </div>
        <button
          type="button"
          onClick={handleSave}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-md transition hover:bg-indigo-700"
        >
          <Save className="h-4 w-4" /> Save Flow
        </button>
      </div>
    </div>
  );
};

const ChatbotBuilder: React.FC = () => (
  <ReactFlowProvider>
    <div className="relative min-h-screen bg-slate-100 p-6">
      <ChatbotBuilderCanvas />
    </div>
  </ReactFlowProvider>
);

export default ChatbotBuilder;
