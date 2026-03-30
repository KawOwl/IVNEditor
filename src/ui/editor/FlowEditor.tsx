/**
 * FlowEditor — ReactFlow 可视化流程图编辑器
 *
 * Step 3.1: 将 FlowGraph 渲染为可拖拽的流程图。
 * 节点按类型显示不同样式，边支持条件标签。
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
import type { FlowGraph, FlowNode as GameFlowNode, NodeType } from '../../core/types';
import { cn } from '../../lib/utils';

// ============================================================================
// Node Colors by Type
// ============================================================================

const NODE_STYLES: Record<NodeType, { bg: string; border: string; text: string }> = {
  scene:          { bg: 'bg-purple-950', border: 'border-purple-600', text: 'text-purple-200' },
  input:          { bg: 'bg-blue-950',   border: 'border-blue-600',   text: 'text-blue-200' },
  compress:       { bg: 'bg-amber-950',  border: 'border-amber-600',  text: 'text-amber-200' },
  'state-update': { bg: 'bg-green-950',  border: 'border-green-600',  text: 'text-green-200' },
  checkpoint:     { bg: 'bg-cyan-950',   border: 'border-cyan-600',   text: 'text-cyan-200' },
};

const NODE_TYPE_LABELS: Record<NodeType, string> = {
  scene: '场景',
  input: '输入',
  compress: '压缩',
  'state-update': '状态更新',
  checkpoint: '检查点',
};

// ============================================================================
// Custom Node Component
// ============================================================================

function GameNode({ data }: { data: { label: string; nodeType: NodeType; gameNode: GameFlowNode } }) {
  const style = NODE_STYLES[data.nodeType];
  return (
    <div className={cn(
      'px-4 py-2 rounded-lg border-2 min-w-[140px] shadow-lg',
      style.bg, style.border,
    )}>
      <Handle type="target" position={Position.Top} className="!bg-zinc-400" />
      <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-0.5">
        {NODE_TYPE_LABELS[data.nodeType]}
      </div>
      <div className={cn('text-sm font-medium', style.text)}>
        {data.label}
      </div>
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
    position: { x: 250, y: index * 120 },  // Auto-layout: vertical stack
    data: {
      label: node.label,
      nodeType: node.type,
      gameNode: node,
    },
  }));
}

function toReactFlowEdges(graph: FlowGraph): Edge[] {
  return graph.edges.map((edge, index) => ({
    id: `edge-${index}`,
    source: edge.from,
    target: edge.to,
    label: edge.label ?? edge.condition,
    animated: !!edge.condition,
    style: { stroke: edge.condition ? '#eab308' : '#71717a' },
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
      // Notify parent of graph change
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
