'use client'
import { useState, useEffect } from 'react'
import { X, Folder, FolderOpen, Loader2, CornerDownRight } from 'lucide-react'
import { clsx } from 'clsx'
import { toast } from 'sonner'
import type { FolderNode } from './FolderTree'

const INGESTION_URL = process.env.NEXT_PUBLIC_INGESTION_URL || 'http://localhost:8003'

interface MoveFolderModalProps {
  docId: string
  docName: string
  orgId: string
  currentFolderId: string | null   // where it lives now
  onClose: () => void
  onMoved: (newFolderId: string | null) => void
}

/** Flatten the nested tree into a display list with depth info. */
function flatten(nodes: FolderNode[], depth = 0): { node: FolderNode; depth: number }[] {
  const result: { node: FolderNode; depth: number }[] = []
  for (const n of nodes) {
    result.push({ node: n, depth })
    result.push(...flatten(n.children, depth + 1))
  }
  return result
}

export function MoveFolderModal({
  docId, docName, orgId, currentFolderId, onClose, onMoved
}: MoveFolderModalProps) {
  const [tree, setTree] = useState<FolderNode[]>([])
  const [loading, setLoading] = useState(true)
  const [targetId, setTargetId] = useState<string | null>(currentFolderId)
  const [moving, setMoving] = useState(false)

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${INGESTION_URL}/folders/tree?org_id=${orgId}`)
        if (res.ok) {
          const data = await res.json()
          setTree(data.tree || [])
        }
      } catch { /* non-fatal */ } finally {
        setLoading(false)
      }
    }
    load()
  }, [orgId])

  const handleMove = async () => {
    if (targetId === currentFolderId) { onClose(); return }
    setMoving(true)
    try {
      const res = await fetch(`${INGESTION_URL}/documents/${docId}/folder`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, folder_id: targetId }),
      })
      if (!res.ok) throw new Error()
      toast.success(targetId ? 'File moved to folder' : 'File moved to root')
      onMoved(targetId)
      onClose()
    } catch {
      toast.error('Failed to move file')
    } finally {
      setMoving(false)
    }
  }

  const flat = flatten(tree)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm flex flex-col max-h-[70vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Move to folder</h2>
            <p className="text-xs text-slate-400 mt-0.5 truncate max-w-xs">{docName}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Folder list */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-slate-400">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading…
            </div>
          ) : (
            <div className="space-y-0.5">
              {/* Root option */}
              <button
                className={clsx(
                  'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors text-left',
                  targetId === null
                    ? 'bg-brand-50 text-brand-700 font-medium'
                    : 'text-slate-600 hover:bg-slate-100'
                )}
                onClick={() => setTargetId(null)}
              >
                <FolderOpen className="w-4 h-4 flex-shrink-0 text-slate-400" />
                <span>Root (unfoldered)</span>
                {currentFolderId === null && (
                  <span className="ml-auto text-[10px] text-slate-400">current</span>
                )}
              </button>

              {flat.length === 0 && (
                <p className="text-xs text-slate-400 text-center py-4">No folders yet</p>
              )}

              {flat.map(({ node, depth }) => (
                <button
                  key={node.id}
                  className={clsx(
                    'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors text-left',
                    targetId === node.id
                      ? 'bg-brand-50 text-brand-700 font-medium'
                      : 'text-slate-700 hover:bg-slate-100'
                  )}
                  style={{ paddingLeft: `${12 + depth * 16}px` }}
                  onClick={() => setTargetId(node.id)}
                >
                  {depth > 0 && <CornerDownRight className="w-3 h-3 flex-shrink-0 text-slate-300" />}
                  {targetId === node.id
                    ? <FolderOpen className="w-4 h-4 flex-shrink-0 text-amber-400" />
                    : <Folder className="w-4 h-4 flex-shrink-0 text-amber-400" />}
                  <span className="flex-1 truncate">{node.name}</span>
                  {currentFolderId === node.id && (
                    <span className="ml-auto text-[10px] text-slate-400">current</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-slate-100">
          <button onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">
            Cancel
          </button>
          <button
            onClick={handleMove}
            disabled={moving || targetId === currentFolderId}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50 transition-colors"
          >
            {moving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Move here
          </button>
        </div>
      </div>
    </div>
  )
}
