import React, { useEffect, useMemo, useState } from 'react';
import { liveApiService } from '../services/liveApiService';
import { DriverExcelColumn, DriverExcelRow } from '../types';
import { GripVertical, Pencil, Plus, Save, Trash2, X } from 'lucide-react';

interface DriverExcelReportProps {
  isLiveMode: boolean;
}

export const DriverExcelReport: React.FC<DriverExcelReportProps> = ({ isLiveMode }) => {
  const [columns, setColumns] = useState<DriverExcelColumn[]>([]);
  const [rows, setRows] = useState<DriverExcelRow[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [editingCell, setEditingCell] = useState<{ rowId: string; colKey: string } | null>(null);
  const [draftValue, setDraftValue] = useState('');
  const [newColumnLabel, setNewColumnLabel] = useState('');
  const [variableOptions, setVariableOptions] = useState<Array<{ key: string; label: string }>>([]);
  const [selectedVariableKey, setSelectedVariableKey] = useState('');
  const [draggingColKey, setDraggingColKey] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<any>(null);

  const loadSyncStatus = async () => {
    if (!isLiveMode) return;
    try {
      const status = await liveApiService.getDriverExcelSyncStatus();
      setSyncStatus(status);
    } catch (e) {
      // ignore status fetch errors to avoid blocking table operations
    }
  };

  const loadReport = async () => {
    if (!isLiveMode) return;
    setLoading(true);
    try {
      const data = await liveApiService.getDriverExcelReport(search);
      setColumns(data.columns);
      setRows(data.rows);
    } catch (e: any) {
      alert(e.message || 'Failed to load driver excel report');
    } finally {
      setLoading(false);
    }
  };

  const loadVariableOptions = async () => {
    if (!isLiveMode) return;
    try {
      const data = await liveApiService.getDriverExcelVariables();
      setVariableOptions(data.variables || []);
      setSelectedVariableKey((prev) => prev || data.variables?.[0]?.key || '');
    } catch (e) {
      // ignore variable-list load failures to keep page functional
    }
  };

  useEffect(() => {
    loadReport();
    loadSyncStatus();
    loadVariableOptions();
  }, [isLiveMode]);

  useEffect(() => {
    if (!isLiveMode) return;
    const interval = setInterval(loadSyncStatus, 2000);
    return () => clearInterval(interval);
  }, [isLiveMode]);

  const filteredRows = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter((row) => {
      return (
        row.name?.toLowerCase().includes(q) ||
        row.phoneNumber?.toLowerCase().includes(q) ||
        row.status?.toLowerCase().includes(q)
      );
    });
  }, [rows, search]);

  const getCellValue = (row: DriverExcelRow, col: DriverExcelColumn) => {
    if (col.key === 'phoneNumber') return row.phoneNumber || '';
    if (col.key === 'name') return row.name || '';
    if (col.key === 'status') return row.status || '';
    if (col.key === 'source') return row.source || '';
    if (col.key === 'createdAt') return row.createdAt || '';
    if (col.key === 'lastMessageAt') return row.lastMessageAt || '';
    return String(row.variables?.[col.key] ?? '');
  };

  const beginEdit = (rowId: string, col: DriverExcelColumn, currentValue: string) => {
    if (col.key === 'createdAt' || col.key === 'lastMessageAt') return;
    setEditingCell({ rowId, colKey: col.key });
    setDraftValue(currentValue);
  };

  const saveCell = async () => {
    if (!editingCell) return;
    try {
      await liveApiService.updateDriverExcelRow(editingCell.rowId, { [editingCell.colKey]: draftValue });
      setEditingCell(null);
      setDraftValue('');
      await loadReport();
      await loadSyncStatus();
    } catch (e: any) {
      alert(e.message || 'Failed to save cell');
    }
  };

  const deleteRow = async (id: string) => {
    if (!confirm('Delete this customer and related messages/documents?')) return;
    await liveApiService.deleteDriverExcelRow(id);
    await loadReport();
    await loadSyncStatus();
    await loadVariableOptions();
  };

  const addVariableColumn = async () => {
    if (!selectedVariableKey) return;
    const selected = variableOptions.find((v) => v.key === selectedVariableKey);
    if (!selected) return;
    await liveApiService.addDriverExcelVariableColumn(selected.key, selected.label);
    await loadReport();
    await loadSyncStatus();
  };

  const addColumn = async () => {
    if (!newColumnLabel.trim()) return;
    await liveApiService.addDriverExcelColumn(newColumnLabel.trim());
    setNewColumnLabel('');
    await loadReport();
    await loadSyncStatus();
  };

  const renameColumn = async (col: DriverExcelColumn) => {
    if (col.isCore) return;
    const newLabel = prompt('Rename column', col.label);
    if (!newLabel || newLabel.trim() === col.label) return;
    await liveApiService.renameDriverExcelColumn(col.key, newLabel.trim());
    await loadReport();
    await loadSyncStatus();
  };

  const deleteColumn = async (col: DriverExcelColumn) => {
    if (col.isCore) return;
    if (!confirm(`Delete column "${col.label}" from all customers?`)) return;
    await liveApiService.deleteDriverExcelColumn(col.key);
    await loadReport();
    await loadSyncStatus();
    await loadVariableOptions();
  };

  const reorderColumns = async (sourceKey: string, targetKey: string) => {
    if (!sourceKey || !targetKey || sourceKey === targetKey) return;
    const next = [...columns];
    const from = next.findIndex((c) => c.key === sourceKey);
    const to = next.findIndex((c) => c.key === targetKey);
    if (from < 0 || to < 0) return;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setColumns(next);
    await liveApiService.reorderDriverExcelColumns(next.map((c) => c.key));
    await loadSyncStatus();
  };

  const syncLabel = (() => {
    if (!syncStatus) return 'Sync status unavailable';
    if (syncStatus.state === 'running') return 'Syncing Excel to S3...';
    if (syncStatus.state === 'queued') return 'Excel sync queued';
    if (syncStatus.state === 'success') return `Last synced ${syncStatus.lastSuccessAt ? new Date(syncStatus.lastSuccessAt).toLocaleString() : 'successfully'}`;
    if (syncStatus.state === 'error') return `Sync failed: ${syncStatus.lastError || 'unknown error'}`;
    return 'Sync idle';
  })();

  const syncBadgeClass = syncStatus?.state === 'error'
    ? 'bg-red-100 text-red-700 border-red-200'
    : syncStatus?.state === 'running' || syncStatus?.state === 'queued'
      ? 'bg-amber-100 text-amber-700 border-amber-200'
      : 'bg-emerald-100 text-emerald-700 border-emerald-200';

  if (!isLiveMode) {
    return <div className="p-8 text-amber-700">Switch to <b>Live API</b> mode to use the Excel report editor.</div>;
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Driver Excel Report</h2>
          <p className="text-sm text-gray-500">Edit, update, delete customer rows and keep S3 driver Excel synchronized.</p>
          <div className={`mt-2 inline-flex items-center px-2.5 py-1 text-xs rounded-full border ${syncBadgeClass}`}>
            {syncLabel}
          </div>
        </div>
        <button onClick={loadReport} className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm">Refresh</button>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-3 flex flex-wrap items-center gap-2">
        <input
          className="px-3 py-2 border rounded-lg text-sm min-w-[260px]"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name / phone / stage"
        />
        <button onClick={loadReport} className="px-3 py-2 border rounded-lg text-sm">Search</button>

        <div className="ml-auto flex items-center gap-2">
          <input
            className="px-3 py-2 border rounded-lg text-sm"
            placeholder="New column label"
            value={newColumnLabel}
            onChange={(e) => setNewColumnLabel(e.target.value)}
          />
          <button onClick={addColumn} className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm flex items-center gap-1"><Plus size={14} /> Add Column</button>
          <div className="flex items-center gap-2 border-l pl-2 ml-1">
            <select
              className="px-3 py-2 border rounded-lg text-sm min-w-[200px]"
              value={selectedVariableKey}
              onChange={(e) => setSelectedVariableKey(e.target.value)}
            >
              {variableOptions.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
            <button onClick={addVariableColumn} className="px-3 py-2 bg-emerald-600 text-white rounded-lg text-sm">Add Variable</button>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className="px-3 py-2 text-left border-b whitespace-nowrap"
                  draggable
                  onDragStart={() => setDraggingColKey(col.key)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={async () => {
                    if (!draggingColKey) return;
                    await reorderColumns(draggingColKey, col.key);
                    setDraggingColKey(null);
                  }}
                  onDragEnd={() => setDraggingColKey(null)}
                >
                  <div className="flex items-center gap-2">
                    <GripVertical size={13} className="text-gray-400" />
                    <span>{col.label}</span>
                    {!col.isCore && (
                      <>
                        <button onClick={() => renameColumn(col)} className="text-gray-500 hover:text-gray-900"><Pencil size={13} /></button>
                        <button onClick={() => deleteColumn(col)} className="text-red-500 hover:text-red-700"><X size={13} /></button>
                      </>
                    )}
                  </div>
                </th>
              ))}
              <th className="px-3 py-2 text-left border-b">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td className="p-4" colSpan={columns.length + 1}>Loading...</td></tr>
            ) : filteredRows.length === 0 ? (
              <tr><td className="p-4" colSpan={columns.length + 1}>No records</td></tr>
            ) : (
              filteredRows.map((row) => (
                <tr key={row.id} className="hover:bg-gray-50">
                  {columns.map((col) => {
                    const isEditing = editingCell?.rowId === row.id && editingCell?.colKey === col.key;
                    const value = getCellValue(row, col);
                    return (
                      <td key={col.key} className="px-3 py-2 border-b align-top min-w-[160px]">
                        {isEditing ? (
                          <div className="flex items-center gap-2">
                            <input className="px-2 py-1 border rounded w-full" value={draftValue} onChange={(e) => setDraftValue(e.target.value)} />
                            <button onClick={saveCell} className="text-green-600"><Save size={14} /></button>
                            <button onClick={() => setEditingCell(null)} className="text-gray-500"><X size={14} /></button>
                          </div>
                        ) : (
                          <button onClick={() => beginEdit(row.id, col, value)} className="text-left w-full">
                            <span className="whitespace-pre-wrap break-words">{value || <span className="text-gray-300">—</span>}</span>
                          </button>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 border-b">
                    <button onClick={() => deleteRow(row.id)} className="text-red-600 hover:text-red-800"><Trash2 size={16} /></button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
