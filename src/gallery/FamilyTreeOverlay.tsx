import { useEffect, useMemo } from "react";
import type { GalleryItem } from "./galleryApi";
import { buildFamilyTree, type FamilyTreeNode } from "./familyTree";
import { shareAppUrl } from "../export/shareCode";

/**
 * Full family tree overlay (F4 "tree viz") — every published branch and
 * generation of one beat's rodokmeň at once, where the 🧬 FAMILY panel only
 * shows the linear view. Generations flow left → right; edges join both the
 * schema-v3 doc lineage and the legacy gallery remix chain (the pre-lineage
 * backfill), so old REMIX threads appear in the same tree as new forks.
 *
 * No graph library: columns are DFS-ordered (children stack under their
 * parents) and edges are one SVG layer of cubic curves underneath the node
 * chips. A tree big enough to overflow scrolls both ways.
 */
export function FamilyTreeOverlay({
  item,
  items,
  onClose,
}: {
  item: GalleryItem;
  items: GalleryItem[];
  onClose: () => void;
}) {
  const tree = useMemo(() => buildFamilyTree(items, item), [items, item]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Simple layered layout: one column per depth, DFS pre-order assigns rows
  // so children render directly under their parents' subtree.
  const layout = useMemo(() => {
    const NODE_W = 188;
    const NODE_H = 52;
    const COL_GAP = 64;
    const ROW_GAP = 14;
    const PAD = 24;
    const nextRow = new Map<number, number>();
    const positions = new Map<string, { x: number; y: number }>();
    let maxRow = 0;
    for (const node of tree.nodes) {
      const row = nextRow.get(node.depth) ?? 0;
      nextRow.set(node.depth, row + 1);
      positions.set(node.item.id, {
        x: PAD + node.depth * (NODE_W + COL_GAP),
        y: PAD + row * (NODE_H + ROW_GAP),
      });
      if (row > maxRow) maxRow = row;
    }
    const maxDepth = tree.nodes.reduce((m, n) => Math.max(m, n.depth), 0);
    return {
      positions,
      width: PAD * 2 + (maxDepth + 1) * NODE_W + maxDepth * COL_GAP,
      height: PAD * 2 + (maxRow + 1) * NODE_H + maxRow * ROW_GAP,
      nodeW: NODE_W,
      nodeH: NODE_H,
    };
  }, [tree]);

  const rootTitle = tree.nodes[0]?.item.title ?? item.title;
  return (
    <div
      className="family-tree-overlay"
      role="dialog"
      aria-label={`Family tree of ${rootTitle}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="family-tree-panel">
        <header className="family-tree-head">
          <span className="family-tree-title">
            🌳 FAMILY TREE — <strong>{rootTitle}</strong>
          </span>
          <span className="family-tree-meta">
            {tree.nodes.length} beat{tree.nodes.length === 1 ? "" : "s"} ·{" "}
            {tree.edges.filter((edge) => edge.viaLegacy).length > 0
              ? `${tree.edges.filter((edge) => edge.viaLegacy).length} legacy link${tree.edges.filter((edge) => edge.viaLegacy).length === 1 ? "" : "s"}`
              : "doc lineage"}
          </span>
          <button type="button" className="family-tree-close" onClick={onClose} aria-label="Close family tree">
            ✕
          </button>
        </header>
        <div className="family-tree-scroll">
          <div className="family-tree-canvas" style={{ width: layout.width, height: layout.height }}>
            <svg className="family-tree-edges" width={layout.width} height={layout.height} aria-hidden="true">
              {tree.edges.map((edge) => {
                const from = layout.positions.get(edge.from);
                const to = layout.positions.get(edge.to);
                if (!from || !to) return null;
                const x1 = from.x + layout.nodeW;
                const y1 = from.y + layout.nodeH / 2;
                const x2 = to.x;
                const y2 = to.y + layout.nodeH / 2;
                const mid = (x1 + x2) / 2;
                return (
                  <path
                    key={`${edge.from}->${edge.to}`}
                    d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                    className={"family-tree-edge" + (edge.viaLegacy ? " via-legacy" : "")}
                  />
                );
              })}
            </svg>
            {tree.nodes.map((node) => (
              <TreeChip
                key={node.item.id}
                node={node}
                x={layout.positions.get(node.item.id)!.x}
                y={layout.positions.get(node.item.id)!.y}
                w={layout.nodeW}
                h={layout.nodeH}
                current={node.item.id === item.id}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function TreeChip({
  node,
  x,
  y,
  w,
  h,
  current,
}: {
  node: FamilyTreeNode;
  x: number;
  y: number;
  w: number;
  h: number;
  current: boolean;
}) {
  const url = shareAppUrl(node.item.code, location.origin);
  return (
    <a
      className={"family-tree-node" + (current ? " current" : "") + (node.viaLegacy ? " via-legacy" : "")}
      style={{ left: x, top: y, width: w, height: h }}
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`Open ${node.item.title} by ${node.item.author} in the studio${node.viaLegacy ? " (legacy remix chain)" : ""}`}
    >
      <span className="family-tree-node-title">
        {node.item.origin === "agent" ? "🤖 " : ""}
        {node.item.title}
      </span>
      <span className="family-tree-node-meta">
        gen {node.depth} · {node.item.author}
        {node.viaLegacy ? " · legacy" : ""}
      </span>
    </a>
  );
}
