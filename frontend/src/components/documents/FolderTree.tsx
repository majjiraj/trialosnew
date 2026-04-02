'use client'
import { useState, useEffect, useCallback } from 'react'
import { Folder, FolderOpen, ChevronRight, ChevronDown, Plus, MoreHorizontal, Pencil, Trash2, FolderPlus } from 'lucide-react'
import { clsx } from 'clsx'
import { toast } from 'sonner'

const INGESTION_URL = process.env.NEXT_PUBLIC_INGESTION_URL || 'http://localhost:8003'

export interface FolderNode {
  id: string
  name: string
  parent_id: string | null
  document_count: number
  children: FolderNode[]
}

interface FolderTreeProps {
  orgId: string
  userId: string
  userName: string
  selectedId: string | null   // null = All Documents (root)
  onSelect: (id: string | null, name: string) => void
  onFileDrop: (docId: string, targetFolderId: string | null) => void
  onRefresh?: () => void
}

interface FolderItemProps {
  node: FolderNode
  depth: number
  selectedId: string | null
  orgId: string
  userId: string
  userName: string
  onSelect: (id: string | null, name: string) => void
  onFileDrop: (docId: string, targetFolderId: string | null) => void
  onMutated: () => void
}

function FolderItem({ node, depth, selectedId, orgId, userId, userName, onSelect, onFileDrop, onMutated }: FolderItemProps) {
  const [expanded, setExpanded] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameName, setRenameName] = useState(node.name)
  const [addingChild, setAddingChild] = useState(false)
  const [newChildName, setNewChildName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)

  const isSelected = selectedId === node.id

  const handleRename = async () => {
    const trimmed = renameName.trim()
    if (!trimmed || trimmed === node.name) { setRenaming(false); return }
    try {
      const res = await fetch(`${INGESTION_URL}/folders/${node.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed })
      })
      if (!res.ok) throw new Error()
      onMutated()
      toast.success('Folder renamed')
    } catch {
      toast.error('Failed to rename folder')
    } finally {
      setRenaming(false)
    }
  }

  const handleAddChild = async () => {
    const trimmed = newChildName.trim()
    if (!trimmed) { setAddingChild(false); return }
    try {
      const res = await fetch(`${INGESTION_URL}/folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, name: trimmed, parent_id: node.id, user_id: userId, user_name: userName })
      })
      if (!res.ok) throw new Error()
      setExpanded(true)
      onMutated()
      toast.success('Subfolder created')
    } catch {
      toast.error('Failed to create subfolder')
    } finally {
      setAddingChild(false)
      setNewChildName('')
    }
  }

  const handleDelete = async () => {
    try {
      const res = await fetch(`${INGESTION_URL}/folders/${node.id}?org_id=${orgId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error()
      onMutated()
      toast.success('Folder deleted')
    } catch {
      toast.error('Failed to delete folder')
    } finally {
      setConfirmDelete(false)
    }
  }

  const hasChildren = node.children.length > 0

  return (
    <div>
      <div
        className={clsx(
          'group flex items-center gap-1 px-2 py-1.5 rounded-lg cursor-pointer text-sm select-none transition-colors',
          isDragOver
            ? 'bg-brand-100 border-2 border-brand-400 border-dashed text-brand-700'
            : isSelected
              ? 'bg-brand-50 text-brand-700'
              : 'text-slate-700 hover:bg-slate-100'
        )}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setIsDragOver(true) }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false) }}
        onDrop={e => {
          e.preventDefault()
          setIsDragOver(false)
          const docId = e.dataTransfer.getData('text/plain')
          if (docId) onFileDrop(docId, node.id)
        }}
      >
        {/* expand/collapse */}
        <button
          className="w-4 h-4 flex items-center justify-center flex-shrink-0 text-slate-400"
          onClick={e => { e.stopPropagation(); setExpanded(!expanded) }}
        >
          {hasChildren
            ? (expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />)
            : <span className="w-3 h-3" />}
        </button>

        {/* folder icon */}
        <span className="flex-shrink-0">
          {isDragOver
            ? <FolderOpen className="w-4 h-4 text-brand-500" />
            : expanded
              ? <FolderOpen className="w-4 h-4 text-amber-400" />
              : <Folder className="w-4 h-4 text-amber-400" />}
        </span>

        {/* name */}
        {renaming ? (
          <input
            autoFocus
            className="flex-1 text-sm border border-brand-300 rounded px-1 py-0 outline-none"
            value={renameName}
            onChange={e => setRenameName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setRenaming(false) }}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span className="flex-1 truncate" onDoubleClick={() => setRenaming(true)} onClick={() => onSelect(node.id, node.name)}>
            {isDragOver ? <span className="font-medium">Drop here</span> : node.name}
          </span>
        )}

        {/* doc count badge */}
        {node.document_count > 0 && !renaming && !isDragOver && (
          <span className="text-[10px] text-slate-400 flex-shrink-0">{node.document_count}</span>
        )}

        {/* context menu */}
        {!renaming && !isDragOver && (
          <div className="relative flex-shrink-0 opacity-0 group-hover:opacity-100">
            <button
              className="p-0.5 rounded hover:bg-slate-200"
              onClick={e => { e.stopPropagation(); setShowMenu(!showMenu) }}
            >
              <MoreHorizontal className="w-3.5 h-3.5 text-slate-400" />
            </button>
            {showMenu && (
              <div
                className="absolute right-0 top-5 z-50 bg-white border border-slate-200 rounded-lg shadow-lg py-1 w-40"
                onMouseLeave={() => setShowMenu(false)}
              >
                <button
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
                  onClick={e => { e.stopPropagation(); setShowMenu(false); setRenaming(true) }}
                >
                  <Pencil className="w-3 h-3" /> Rename
                </button>
                <button
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
                  onClick={e => { e.stopPropagation(); setShowMenu(false); setAddingChild(true); setExpanded(true) }}
                >
                  <FolderPlus className="w-3 h-3" /> New subfolder
                </button>
                <button
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-red-600 hover:bg-red-50"
                  onClick={e => { e.stopPropagation(); setShowMenu(false); setConfirmDelete(true) }}
                >
                  <Trash2 className="w-3 h-3" /> Delete
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Inline child-name input */}
      {addingChild && expanded && (
        <div style={{ paddingLeft: `${8 + (depth + 1) * 16 + 20}px` }} className="pr-2 py-1">
          <input
            autoFocus
            placeholder="Folder name…"
            className="w-full text-sm border border-brand-300 rounded px-2 py-1 outline-none"
            value={newChildName}
            onChange={e => setNewChildName(e.target.value)}
            onBlur={() => { if (!newChildName.trim()) setAddingChild(false) }}
            onKeyDown={e => { if (e.key === 'Enter') handleAddChild(); if (e.key === 'Escape') { setAddingChild(false); setNewChildName('') } }}
          />
        </div>
      )}

      {/* Children */}
      {expanded && node.children.map(child => (
        <FolderItem
          key={child.id}
          node={child}
          depth={depth + 1}
          selectedId={selectedId}
          orgId={orgId}
          userId={userId}
          userName={userName}
          onSelect={onSelect}
          onFileDrop={onFileDrop}
          onMutated={onMutated}
        />
      ))}

      {/* Delete confirm dialog */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setConfirmDelete(false)}>
          <div className="absolute inset-0 bg-slate-900/50" />
          <div className="relative bg-white rounded-xl shadow-xl p-5 max-w-sm w-full" onClick={e => e.stopPropagation()}>
            <p className="text-sm font-semibold text-slate-900 mb-2">Delete &quot;{node.name}&quot;?</p>
            <p className="text-xs text-slate-500 mb-4">
              Documents inside will be moved to the parent folder. Subfolders will also be moved up.
            </p>
            <div className="flex gap-2 justify-end">
              <button className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg" onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button className="px-3 py-1.5 text-xs bg-red-600 text-white rounded-lg hover:bg-red-700" onClick={handleDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function FolderTree({ orgId, userId, userName, selectedId, onSelect, onFileDrop, onRefresh }: FolderTreeProps) {
  const [tree, setTree] = useState<FolderNode[]>([])
  const [rootCount, setRootCount] = useState(0)
  const [newFolderName, setNewFolderName] = useState('')
  const [addingRoot, setAddingRoot] = useState(false)
  const [rootDragOver, setRootDragOver] = useState(false)

  const loadTree = useCallback(async () => {
    try {
      const res = await fetch(`${INGESTION_URL}/folders/tree?org_id=${orgId}`)
      if (res.ok) {
        const data = await res.json()
        setTree(data.tree || [])
        setRootCount(data.root_document_count ?? 0)
      }
    } catch { /* non-fatal */ }
  }, [orgId])

  useEffect(() => { loadTree() }, [loadTree])

  const handleMutated = () => {
    loadTree()
    onRefresh?.()
  }

  const handleCreateRoot = async () => {
    const trimmed = newFolderName.trim()
    if (!trimmed) { setAddingRoot(false); return }
    try {
      const res = await fetch(`${INGESTION_URL}/folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, name: trimmed, parent_id: null, user_id: userId, user_name: userName })
      })
      if (!res.ok) throw new Error()
      handleMutated()
      toast.success('Folder created')
    } catch {
      toast.error('Failed to create folder')
    } finally {
      setAddingRoot(false)
      setNewFolderName('')
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wider">Folders</div>

      {/* All Documents (root) — also a drop target for unassigning */}
      <div
        className={clsx(
          'flex items-center gap-2 px-3 py-1.5 rounded-lg cursor-pointer text-sm mx-1 transition-colors',
          rootDragOver
            ? 'bg-brand-100 border-2 border-brand-400 border-dashed text-brand-700'
            : selectedId === null
              ? 'bg-brand-50 text-brand-700 font-medium'
              : 'text-slate-700 hover:bg-slate-100'
        )}
        onClick={() => onSelect(null, 'All Documents')}
        onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setRootDragOver(true) }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setRootDragOver(false) }}
        onDrop={e => {
          e.preventDefault()
          setRootDragOver(false)
          const docId = e.dataTransfer.getData('text/plain')
          if (docId) onFileDrop(docId, null)
        }}
      >
        <FolderOpen className={clsx('w-4 h-4 flex-shrink-0', rootDragOver ? 'text-brand-500' : 'text-slate-400')} />
        <span className="flex-1">{rootDragOver ? 'Drop to unassign' : 'All Documents'}</span>
        {rootCount > 0 && !rootDragOver && <span className="text-[10px] text-slate-400">{rootCount}</span>}
      </div>

      {/* Folder tree */}
      <div className="flex-1 overflow-y-auto mt-1 mx-1 space-y-0.5">
        {tree.map(node => (
          <FolderItem
            key={node.id}
            node={node}
            depth={0}
            selectedId={selectedId}
            orgId={orgId}
            userId={userId}
            userName={userName}
            onSelect={onSelect}
            onFileDrop={onFileDrop}
            onMutated={handleMutated}
          />
        ))}
      </div>

      {/* Add root folder */}
      <div className="mt-2 px-3 pb-3">
        {addingRoot ? (
          <input
            autoFocus
            placeholder="New folder name…"
            className="w-full text-sm border border-brand-300 rounded-lg px-2 py-1.5 outline-none"
            value={newFolderName}
            onChange={e => setNewFolderName(e.target.value)}
            onBlur={() => { if (!newFolderName.trim()) setAddingRoot(false) }}
            onKeyDown={e => { if (e.key === 'Enter') handleCreateRoot(); if (e.key === 'Escape') { setAddingRoot(false); setNewFolderName('') } }}
          />
        ) : (
          <button
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-brand-600 py-1"
            onClick={() => setAddingRoot(true)}
          >
            <Plus className="w-3.5 h-3.5" /> New Folder
          </button>
        )}
      </div>
    </div>
  )
}
