
import { create } from 'zustand';
import {
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
} from '@xyflow/react';
import type {
  Connection,
  Edge,
  EdgeChange,
  Node,
  NodeChange,
  OnNodesChange,
  OnEdgesChange,
  OnConnect,
} from '@xyflow/react';
import { FlowNodeData } from '../types';

interface FlowState {
  nodes: Node<FlowNodeData>[];
  edges: Edge[];
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  setNodes: (nodes: Node<FlowNodeData>[]) => void;
  setEdges: (edges: Edge[]) => void;
  addNode: (node: Node<FlowNodeData>) => void;
  updateNodeData: (id: string, data: Partial<FlowNodeData>) => void;
  deleteNode: (id: string) => void;
  resetFlow: () => void;
}

const initialNodes: Node<FlowNodeData>[] = [
    { 
        id: 'start', 
        type: 'custom', 
        position: { x: 50, y: 300 }, 
        data: { id: 'start', type: 'start', label: 'Start Flow' } 
    }
];

export const useFlowStore = create<FlowState>((set, get) => ({
  nodes: initialNodes,
  edges: [],
  
  onNodesChange: (changes: NodeChange[]) => {
    set({
      nodes: applyNodeChanges(changes, get().nodes) as unknown as Node<FlowNodeData>[],
    });
  },
  
  onEdgesChange: (changes: EdgeChange[]) => {
    set({
      edges: applyEdgeChanges(changes, get().edges),
    });
  },
  
  onConnect: (connection: Connection) => {
    set({
      edges: addEdge({ 
          ...connection, 
          type: 'smoothstep', 
          animated: true,
          style: { stroke: '#64748b', strokeWidth: 2 },
      }, get().edges),
    });
  },

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),

  addNode: (node) => {
      set({ nodes: [...get().nodes, node] });
  },

  updateNodeData: (id, data) => {
    set({
      nodes: get().nodes.map((node) => {
        if (node.id === id) {
          // Deep merge logic if needed, or simple spread
          return { ...node, data: { ...node.data, ...data } };
        }
        return node;
      }),
    });
  },

  deleteNode: (id) => {
      set({
          nodes: get().nodes.filter(n => n.id !== id),
          edges: get().edges.filter(e => e.source !== id && e.target !== id)
      });
  },

  resetFlow: () => {
      set({ nodes: initialNodes, edges: [] });
  }
}));