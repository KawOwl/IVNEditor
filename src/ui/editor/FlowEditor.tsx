/**
 * FlowEditor — ReactFlow 可视化流程图编辑器
 *
 * 将 FlowGraph 渲染为可拖拽的流程图。
 * FlowGraph 是可视化参考，不做运行时路由。
 */

import { useCallback, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { FlowGraph, FlowNode as GameFlowNode } from '../../core/types';
import { cn } from '../../lib/utils';

// ============================================================================
// Custom Node Component
// ============================================================================

function GameNode({ data }: { data: { label: string; description?: string; gameNode: GameFlowNode } }) {
  return (
    <div className={cn(
      'px-4 py-2 rounded-lg border-2 min-w-[140px] shadow-lg',
      'bg-zinc-900 border-zinc-600',
    )}>
      <Handle type="target" position={Position.Top} className="!bg-zinc-400" />
      <div className={cn('text-sm font-medium text-zinc-200')}>
        {data.label}
      </div>
      {data.description && (
        <div className="text-[10px] text-zinc-500 mt-0.5">{data.description}</div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-zinc-400" />
    </div>
  );
}

// ============================================================================
// Convert FlowGraph → ReactFlow nodes/edges
// ============================================================================

function toReactFlowNodes(graph: FlowGraph): Node[] {
  return graph.nodes.map((node, index) => ({
    id: node.id,
    type: 'gameNode',
    position: { x: 250, y: index * 120 },
    data: {
      label: node.label,
      description: node.description,
      gameNode: node,
    },
  }));
}

function toReactFlowEdges(graph: FlowGraph): Edge[] {
  return graph.edges.map((edge, index) => ({
    id: `edge-${index}`,
    source: edge.from,
    target: edge.to,
    label: edge.label,
    style: { stroke: '#71717a' },
    labelStyle: { fill: '#a1a1aa', fontSize: 11 },
  }));
}

// ============================================================================
// FlowEditor Component
// ============================================================================

export interface FlowEditorProps {
  graph: FlowGraph;
  onNodeSelect?: (nodeId: string) => void;
  onEdgeSelect?: (edgeIndex: number) => void;
  onGraphChange?: (graph: FlowGraph) => void;
}

const nodeTypes: NodeTypes = {
  gameNode: GameNode,
};

export function FlowEditor({ graph, onNodeSelect, onEdgeSelect, onGraphChange }: FlowEditorProps) {
  const initialNodes = useMemo(() => toReactFlowNodes(graph), [graph]);
  const initialEdges = useMemo(() => toReactFlowEdges(graph), [graph]);

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const onConnect = useCallback(
    (params: Connection) => {
      setEdges((eds) => addEdge({ ...params, style: { stroke: '#71717a' } }, eds));
      if (onGraphChange) {
        const newEdge = { from: params.source!, to: params.target! };
        onGraphChange({
          ...graph,
          edges: [...graph.edges, newEdge],
        });
      }
    },
    [setEdges, graph, onGraphChange],
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onNodeSelect?.(node.id);
    },
    [onNodeSelect],
  );

  const onEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      const index = edges.findIndex((e) => e.id === edge.id);
      onEdgeSelect?.(index);
    },
    [edges, onEdgeSelect],
  );

  return (
    <div className="w-full h-full" style={{ minHeight: 400 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        nodeTypes={nodeTypes}
        fitView
        className="bg-zinc-950"
      >
        <Background color="#27272a" gap={20} />
        <Controls className="!bg-zinc-800 !border-zinc-700 [&>button]:!bg-zinc-800 [&>button]:!border-zinc-700 [&>button]:!text-zinc-400" />
        <MiniMap
          nodeStrokeColor="#3f3f46"
          nodeColor="#18181b"
          maskColor="rgba(0,0,0,0.7)"
          className="!bg-zinc-900 !border-zinc-700"
        />
      </ReactFlow>
    </div>
  );
}
