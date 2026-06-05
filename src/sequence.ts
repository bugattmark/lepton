// The canvas sequence: nodes the user drags around + edges connecting them.
// This is the source of truth for what a campaign does. The engine walks it per lead.
//
//   start ──▶ send ──▶ wait ──▶ ifreply ──▶ (yes: stop) / (no: loop back to send)
//
// Kept deliberately small: four block types, one optional branch. A Wait→Send edge IS
// the follow-up loop, so there is no separate "follow-up" or "rest" knob anymore.

export type NodeType = 'start' | 'send' | 'wait' | 'ifreply'

export interface SendData {
  message: string // body with {{instagram_handle}} / {{instagram_link}}
  hourlyCap: number // max sends per hour on the number firing this step
  minGap: number // min seconds between sends
  maxGap: number // max seconds between sends
  aiPersonalize?: boolean // optional: let Claude rewrite the opener
  aiPrompt?: string | null // steering instruction for the AI opener
}
export interface WaitData {
  minutes: number
}

export interface SeqNode {
  id: string
  type: NodeType
  x: number
  y: number
  data?: SendData | WaitData | Record<string, unknown>
}
export interface SeqEdge {
  from: string
  to: string
  branch?: 'yes' | 'no' // only meaningful out of an ifreply node
}
export interface Sequence {
  nodes: SeqNode[]
  edges: SeqEdge[]
}

export const DEFAULT_SEND: SendData = { message: '', hourlyCap: 25, minGap: 25, maxGap: 70 }

export function parseSequence(raw: string | null): Sequence | null {
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as Sequence
    if (Array.isArray(s.nodes) && Array.isArray(s.edges)) return s
  } catch {
    /* fall through */
  }
  return null
}

// Build a trivial sequence (start → one send) from a plain template — keeps old campaigns working.
export function fallbackSequence(template: string): Sequence {
  return {
    nodes: [
      { id: 'start', type: 'start', x: 40, y: 40 },
      { id: 'send1', type: 'send', x: 40, y: 160, data: { ...DEFAULT_SEND, message: template } },
    ],
    edges: [{ from: 'start', to: 'send1' }],
  }
}

export const nodeById = (seq: Sequence, id: string | null): SeqNode | undefined =>
  id ? seq.nodes.find((n) => n.id === id) : undefined

// The single edge leaving `from` (matching `branch` if the node is an ifreply).
export function outgoing(seq: Sequence, from: string, branch?: 'yes' | 'no'): string | null {
  const edges = seq.edges.filter((e) => e.from === from)
  if (branch) return edges.find((e) => e.branch === branch)?.to ?? null
  return edges[0]?.to ?? null
}

// Where a freshly-enrolled lead starts: the first real block after `start`.
export function firstNode(seq: Sequence): string | null {
  const start = seq.nodes.find((n) => n.type === 'start')
  if (start) return outgoing(seq, start.id)
  return seq.nodes.find((n) => n.type === 'send')?.id ?? null
}

export const asSend = (n: SeqNode | undefined): SendData | undefined =>
  n && n.type === 'send' ? (n.data as SendData) : undefined
export const asWait = (n: SeqNode | undefined): WaitData | undefined =>
  n && n.type === 'wait' ? (n.data as WaitData) : undefined
