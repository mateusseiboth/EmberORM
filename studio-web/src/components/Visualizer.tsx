import { useMemo } from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";
import type { StudioModel, StudioSchema } from "../types";

interface Props {
  schema: StudioSchema;
  onOpenModel: (name: string) => void;
}

interface ModelNodeData {
  model: StudioModel;
  onOpenModel: (name: string) => void;
}

/** A model rendered as a draggable ERD table card. */
function ModelNode({ data }: NodeProps<ModelNodeData>) {
  const { model, onOpenModel } = data;
  return (
    <div className="erd-card">
      <Handle type="target" position={Position.Left} className="erd-handle" />
      <button className="erd-title nodrag" onClick={() => onOpenModel(model.name)}>
        {model.name}
      </button>
      <table className="erd-fields">
        <tbody>
          {model.fields.map((f) => (
            <tr key={f.name} className={f.kind === "object" ? "erd-rel" : undefined}>
              <td className="erd-field-name">
                {f.isId && <span className="erd-pk" title="primary key">🔑</span>}
                {f.name}
              </td>
              <td className="erd-field-type">
                {f.kind === "object" ? (
                  <span className="link">
                    {f.type}
                    {f.isList ? "[]" : ""}
                  </span>
                ) : (
                  <span className="muted">
                    {f.type}
                    {f.isList ? "[]" : ""}
                    {f.isRequired ? "" : "?"}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Handle type="source" position={Position.Right} className="erd-handle" />
    </div>
  );
}

const nodeTypes = { model: ModelNode };

/** Grid placement: enough spacing that cards rarely overlap before the user drags. */
function layout(models: StudioModel[], onOpenModel: Props["onOpenModel"]): Node<ModelNodeData>[] {
  const COLS = Math.max(1, Math.ceil(Math.sqrt(models.length)));
  return models.map((model, i) => ({
    id: model.name,
    type: "model",
    position: { x: (i % COLS) * 340, y: Math.floor(i / COLS) * 360 },
    data: { model, onOpenModel },
  }));
}

/** One edge per FK relation (only the side that holds `relation.fields`). */
function relationEdges(models: StudioModel[]): Edge[] {
  const names = new Set(models.map((m) => m.name));
  const edges: Edge[] = [];
  for (const m of models) {
    for (const f of m.fields) {
      const fks = f.relation?.fields ?? [];
      if (f.kind !== "object" || fks.length === 0 || !names.has(f.type)) continue;
      edges.push({
        id: `${m.name}.${f.name}->${f.type}`,
        source: m.name,
        target: f.type,
        animated: true,
        style: { stroke: "#ff7849" },
        label: f.name,
      });
    }
  }
  return edges;
}

/**
 * Schema overview as an interactive ERD: draggable model cards, relation edges,
 * a minimap, and pan/zoom controls — mirroring Prisma Studio's Visualizer.
 */
export function Visualizer({ schema, onOpenModel }: Props) {
  const initialNodes = useMemo(
    () => layout(schema.models, onOpenModel),
    [schema, onOpenModel],
  );
  const initialEdges = useMemo(() => relationEdges(schema.models), [schema]);

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);

  if (schema.models.length === 0) {
    return <p className="result-note">No models in schema.</p>;
  }

  return (
    <div className="visualizer">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        fitView
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} color="#262b3a" />
        <Controls />
        <MiniMap
          pannable
          zoomable
          nodeColor="#1c2030"
          nodeStrokeColor="#ff7849"
          maskColor="rgba(15,17,21,0.7)"
          style={{ backgroundColor: "#161922" }}
        />
      </ReactFlow>
    </div>
  );
}
