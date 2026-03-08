import React, { useEffect, useMemo, useState } from 'react';
import { liveApiService } from '../services/liveApiService';
import { DriverExcelColumn, DriverExcelRow } from '../types';
import { ArrowDown, ArrowUp, CheckSquare, GripVertical, Pencil, Plus, RotateCcw, Save, Trash2, X } from 'lucide-react';

interface VariableOption {
  key: string;
  label: string;
}

interface SavedColumnView {
  id: string;
  name: string;
  keys: string[];
}

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
  const [variableOptions, setVariableOptions] = useState<VariableOption[]>([]);
  const [variableFilter, setVariableFilter] = useState('');
  const [selectedVariableKeys, setSelectedVariableKeys] = useState<string[]>([]);
  const [manuallyRemovedVariableKeys, setManuallyRemovedVariableKeys] = useState<string[]>([]);
  const [savedViews, setSavedViews] = useState<SavedColumnView[]>([]);
  const [selectedViewId, setSelectedViewId] = useState('');
  const [autoAddNewVariables, setAutoAddNewVariables] = useState(false);
  const [draggingColKey, setDraggingColKey] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<any>(null);
  const [actor, setActor] = useState<{ email: string; role: 'admin' | 'staff' } | null>(null);
  const [uiMessage, setUiMessage] = useState('');
  const [actionKey, setActionKey] = useState<string | null>(null);

  const getCurrentUserScope = () => {
    try {
      const token = localStorage.getItem('uber_fleet_auth_token') || '';
      const payload = token.split('.')[1];
      if (!payload) return 'anonymous';
      const parsed = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
      return parsed?.email || parsed?.sub || 'anonymous';
    } catch {
      return 'anonymous';
    }
  };

  const getColumnPrefsStorageKey = () => `driver_excel_columns_pref_${getCurrentUserScope()}`;
  const getColumnViewsStorageKey = () => `driver_excel_column_views_${getCurrentUserScope()}`;
  const getAutoAddStorageKey = () => `driver_excel_auto_add_vars_${getCurrentUserScope()}`;

  const columnKeySet = useMemo(() => new Set(columns.map((c) => c.key)), [columns]);

  const showMessage = (message: string) => {
    setUiMessage(message);
    setTimeout(() => setUiMessage(''), 2400);
  };

  const addVariableColumnsByKeys = async (keys: string[], messagePrefix: string = 'Added') => {
    const keysToAdd = keys.filter((key) => !columnKeySet.has(key));
    if (keysToAdd.length === 0) return { successCount: 0, failedCount: 0 };

    const lookup = new Map(variableOptions.map((v) => [v.key, v]));
    const results = await Promise.allSettled(
      keysToAdd.map((key) => {
        const selected = lookup.get(key);
        if (!selected) return Promise.resolve();
        return liveApiService.addDriverExcelVariableColumn(selected.key, selected.label || selected.key);
      })
    );

    const successfulKeys = results
      .map((result, index) => ({ result, key: keysToAdd[index] }))
      .filter((item) => item.result.status === 'fulfilled')
      .map((item) => item.key);

    if (successfulKeys.length > 0) {
      setManuallyRemovedVariableKeys((prev) => prev.filter((k) => !successfulKeys.includes(k)));
    }

    const successCount = successfulKeys.length;
    const failedCount = results.length - successCount;
    showMessage(`${messagePrefix} ${successCount} variable column(s)${failedCount > 0 ? `, ${failedCount} failed` : ''}.`);
    return { successCount, failedCount };
  };

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
      const rawColumns = data.columns || [];
      const prefKey = getColumnPrefsStorageKey();
      const savedKeys = JSON.parse(localStorage.getItem(prefKey) || 'null') as string[] | null;
      const byKey = new Map(rawColumns.map((c) => [c.key, c]));
      let nextColumns = rawColumns;
      if (Array.isArray(savedKeys) && savedKeys.length > 0) {
        const ordered = savedKeys.map((key) => byKey.get(key)).filter(Boolean) as DriverExcelColumn[];
        const seen = new Set(ordered.map((c) => c.key));
        const rest = rawColumns.filter((c) => !seen.has(c.key));
        nextColumns = [...ordered, ...rest];
      }
      setColumns(nextColumns);
      setRows(data.rows);
      setActor(data.actor || null);
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
      const vars = data.variables || [];
      setVariableOptions(vars);
      setSelectedVariableKeys((prev) => prev.filter((k) => vars.some((v) => v.key === k)));
      setManuallyRemovedVariableKeys((prev) => prev.filter((k) => vars.some((v) => v.key === k)));
    } catch (e) {
      // ignore variable-list load failures to keep page functional
    }
  };

  useEffect(() => {
    loadReport();
    loadSyncStatus();
    loadVariableOptions();

    const savedRaw = localStorage.getItem(getColumnViewsStorageKey());
    if (savedRaw) {
      try {
        const parsed = JSON.parse(savedRaw);
        if (Array.isArray(parsed)) setSavedViews(parsed);
      } catch {
        setSavedViews([]);
      }
    }

    const autoAddRaw = localStorage.getItem(getAutoAddStorageKey());
    setAutoAddNewVariables(autoAddRaw === '1');
  }, [isLiveMode]);

  useEffect(() => {
    if (!isLiveMode) return;
    const interval = setInterval(loadSyncStatus, 2000);
    return () => clearInterval(interval);
  }, [isLiveMode]);

  useEffect(() => {
    if (!isLiveMode || columns.length === 0) return;
    const prefKey = getColumnPrefsStorageKey();
    localStorage.setItem(prefKey, JSON.stringify(columns.map((c) => c.key)));
  }, [columns, isLiveMode]);

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

  const filteredVariableOptions = useMemo(() => {
    const hiddenKeys = columnKeySet;
    const q = variableFilter.trim().toLowerCase();
    return variableOptions
      .filter((v) => !hiddenKeys.has(v.key))
      .filter((v) => !q || v.label.toLowerCase().includes(q) || v.key.toLowerCase().includes(q));
  }, [variableOptions, variableFilter, columnKeySet]);

  const variableStats = useMemo(() => {
    const total = rows.length || 1;
    const stats = new Map<string, { filledCount: number; fillRate: number; sampleValue: string }>();

    variableOptions.forEach((option) => {
      let filledCount = 0;
      let sampleValue = '';
      for (const row of rows) {
        const raw = row.variables?.[option.key];
        const value = raw === null || raw === undefined ? '' : String(raw).trim();
        if (value !== '') {
          filledCount += 1;
          if (!sampleValue) sampleValue = value;
        }
      }
      stats.set(option.key, {
        filledCount,
        fillRate: Math.round((filledCount / total) * 100),
        sampleValue
      });
    });

    return stats;
  }, [rows, variableOptions]);

  const recommendedVariableKeys = useMemo(() => {
    return filteredVariableOptions
      .map((option) => ({
        key: option.key,
        fillRate: variableStats.get(option.key)?.fillRate || 0
      }))
      .filter((entry) => entry.fillRate >= 30)
      .sort((a, b) => b.fillRate - a.fillRate)
      .slice(0, 8)
      .map((entry) => entry.key);
  }, [filteredVariableOptions, variableStats]);

  const getCellValue = (row: DriverExcelRow, col: DriverExcelColumn) => {
    if (col.key === 'phoneNumber') return row.phoneNumber || '';
    if (col.key === 'name') return row.name || '';
    if (col.key === 'status') return row.status || '';
    if (col.key === 'source') return row.source || '';
    if (col.key === 'createdAt') return row.createdAt || '';
    if (col.key === 'lastMessageAt') return row.lastMessageAt || '';
    if (col.key === 'ownerStaffEmail') return row.ownerStaffEmail || '';
    if (col.key === 'claimedAt') return row.claimedAt || '';
    return String(row.variables?.[col.key] ?? '');
  };

  const isReadOnlyColumn = (key: string) => key === 'createdAt' || key === 'lastMessageAt' || key === 'ownerStaffEmail' || key === 'claimedAt' || key.endsWith('_status') || key.endsWith('_uploaded_at');

  const beginEdit = (rowId: string, col: DriverExcelColumn, currentValue: string) => {
    if (isReadOnlyColumn(col.key)) return;
    setEditingCell({ rowId, colKey: col.key });
    setDraftValue(currentValue);
  };


  const canEditRow = (row: DriverExcelRow) => {
    if (!actor) return false;
    if (actor.role === 'admin') return true;
    const owner = (row.ownerStaffEmail || '').toLowerCase();
    return !owner || owner === actor.email;
  };

  const claimLead = async (id: string) => {
    setActionKey(`claim-${id}`);
    try {
      await liveApiService.claimDriverExcelLead(id);
      await loadReport();
      showMessage('Lead collected to your portal.');
    } catch (e: any) {
      showMessage(e.message || 'Failed to collect lead');
    } finally {
      setActionKey(null);
    }
  };

  const releaseLead = async (id: string) => {
    setActionKey(`release-${id}`);
    try {
      await liveApiService.releaseDriverExcelLead(id);
      await loadReport();
      showMessage('Lead removed from portal and returned to pool.');
    } catch (e: any) {
      showMessage(e.message || 'Failed to release lead');
    } finally {
      setActionKey(null);
    }
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

  const addSelectedVariables = async () => {
    if (selectedVariableKeys.length === 0) return;
    setActionKey('add-selected-variables');
    if (selectedVariableKeys.every((key) => columnKeySet.has(key))) {
      showMessage('Selected variables are already added.');
      setActionKey(null);
      return;
    }

    try {
      await addVariableColumnsByKeys(selectedVariableKeys);
      await loadReport();
      await loadSyncStatus();
      await loadVariableOptions();
      setSelectedVariableKeys([]);
    } catch (e: any) {
      showMessage(e.message || 'Failed to add variable columns.');
    } finally {
      setActionKey(null);
    }
  };

  const addRecommendedVariables = async () => {
    if (recommendedVariableKeys.length === 0) {
      showMessage('No recommended variables available right now.');
      return;
    }
    setActionKey('add-recommended-variables');
    try {
      await addVariableColumnsByKeys(recommendedVariableKeys, 'Recommended: added');
      await loadReport();
      await loadSyncStatus();
      await loadVariableOptions();
      setSelectedVariableKeys((prev) => prev.filter((key) => !recommendedVariableKeys.includes(key)));
    } catch (e: any) {
      showMessage(e.message || 'Failed to add recommended variables.');
    } finally {
      setActionKey(null);
    }
  };

  const addColumn = async () => {
    if (!newColumnLabel.trim()) return;
    setActionKey('add-column');
    try {
      await liveApiService.addDriverExcelColumn(newColumnLabel.trim());
      setNewColumnLabel('');
      await loadReport();
      await loadSyncStatus();
    } catch (e: any) {
      showMessage(e.message || 'Failed to add column');
    } finally {
      setActionKey(null);
    }
  };

  const renameColumn = async (col: DriverExcelColumn) => {
    if (col.isCore) return;
    const newLabel = prompt('Rename column', col.label);
    if (!newLabel || newLabel.trim() === col.label) return;
    setActionKey(`rename-${col.key}`);
    try {
      await liveApiService.renameDriverExcelColumn(col.key, newLabel.trim());
      await loadReport();
      await loadSyncStatus();
    } catch (e: any) {
      showMessage(e.message || 'Failed to rename column');
    } finally {
      setActionKey(null);
    }
  };

  const deleteColumn = async (col: DriverExcelColumn) => {
    if (col.isCore) return;
    if (!confirm(`Delete column "${col.label}" from all customers?`)) return;
    setActionKey(`delete-${col.key}`);
    try {
      await liveApiService.deleteDriverExcelColumn(col.key);
      setManuallyRemovedVariableKeys((prev) => (prev.includes(col.key) ? prev : [...prev, col.key]));
      setSelectedVariableKeys((prev) => prev.filter((key) => key !== col.key));
      await loadReport();
      await loadSyncStatus();
      await loadVariableOptions();
    } catch (e: any) {
      showMessage(e.message || 'Failed to delete column');
    } finally {
      setActionKey(null);
    }
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
    showMessage('Column order saved.');
  };

  const resetColumnOrder = async () => {
    setActionKey('reset-order');
    try {
      await liveApiService.reorderDriverExcelColumns([]);
      await loadReport();
      await loadSyncStatus();
      showMessage('Column order reset to default.');
    } catch (e: any) {
      showMessage(e.message || 'Failed to reset column order.');
    } finally {
      setActionKey(null);
    }
  };

  const toggleVariableSelection = (key: string, checked: boolean) => {
    if (checked) {
      setSelectedVariableKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
    } else {
      setSelectedVariableKeys((prev) => prev.filter((k) => k !== key));
    }
  };

  const selectAllFilteredVariables = () => {
    setSelectedVariableKeys(filteredVariableOptions.map((option) => option.key));
  };

  const clearSelectedVariables = () => setSelectedVariableKeys([]);

  const persistSavedViews = (views: SavedColumnView[]) => {
    setSavedViews(views);
    localStorage.setItem(getColumnViewsStorageKey(), JSON.stringify(views));
  };

  const saveCurrentView = () => {
    const name = prompt('View name', `View ${savedViews.length + 1}`);
    if (!name?.trim()) return;
    const customKeys = columns.filter((c) => !c.isCore).map((c) => c.key);
    const next: SavedColumnView[] = [
      ...savedViews,
      {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: name.trim(),
        keys: customKeys
      }
    ];
    persistSavedViews(next);
    showMessage('Saved current view.');
  };

  const applySavedView = async (viewId: string) => {
    setSelectedViewId(viewId);
    if (!viewId) return;
    const view = savedViews.find((item) => item.id === viewId);
    if (!view) return;

    setActionKey('apply-view');
    try {
      const existingCustomKeys = columns.filter((c) => !c.isCore).map((c) => c.key);
      const keysToDelete = existingCustomKeys.filter((key) => !view.keys.includes(key));
      for (const key of keysToDelete) {
        await liveApiService.deleteDriverExcelColumn(key);
      }

      await addVariableColumnsByKeys(view.keys, 'View: added');
      await liveApiService.reorderDriverExcelColumns(view.keys);
      await loadReport();
      await loadVariableOptions();
      await loadSyncStatus();
      showMessage(`Applied view: ${view.name}`);
    } catch (e: any) {
      showMessage(e.message || 'Failed to apply view.');
    } finally {
      setActionKey(null);
    }
  };

  const deleteSavedView = () => {
    if (!selectedViewId) return;
    const target = savedViews.find((v) => v.id === selectedViewId);
    if (!target) return;
    if (!confirm(`Delete saved view "${target.name}"?`)) return;
    const next = savedViews.filter((v) => v.id !== selectedViewId);
    persistSavedViews(next);
    setSelectedViewId('');
    showMessage('Saved view deleted.');
  };

  useEffect(() => {
    localStorage.setItem(getAutoAddStorageKey(), autoAddNewVariables ? '1' : '0');
  }, [autoAddNewVariables]);

  useEffect(() => {
    const autoAddMissingVariables = async () => {
      if (!isLiveMode || !autoAddNewVariables || actionKey) return;
      const missing = variableOptions
        .map((v) => v.key)
        .filter((key) => !columnKeySet.has(key) && !manuallyRemovedVariableKeys.includes(key));
      if (missing.length === 0) return;

      setActionKey('auto-add-variables');
      try {
        await addVariableColumnsByKeys(missing, 'Auto-added');
        await loadReport();
        await loadVariableOptions();
        await loadSyncStatus();
      } catch (e: any) {
        showMessage(e.message || 'Auto-add variables failed.');
      } finally {
        setActionKey(null);
      }
    };

    autoAddMissingVariables();
  }, [isLiveMode, autoAddNewVariables, variableOptions, columnKeySet, manuallyRemovedVariableKeys, actionKey]);

  const moveColumn = async (col: DriverExcelColumn, direction: 'up' | 'down') => {
    if (col.isCore) return;
    const customCols = columns.filter((c) => !c.isCore);
    const currentIndex = customCols.findIndex((c) => c.key === col.key);
    if (currentIndex < 0) return;
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= customCols.length) return;

    const next = [...customCols];
    const [current] = next.splice(currentIndex, 1);
    next.splice(targetIndex, 0, current);
    await liveApiService.reorderDriverExcelColumns(next.map((c) => c.key));
    await loadReport();
    await loadSyncStatus();
  };

  const syncLabel = (() => {
    if (!syncStatus) return 'Sync status unavailable';
    if (syncStatus.state === 'running') return 'Syncing Driver Excel to S3 and Google Sheets...';
    if (syncStatus.state === 'queued') return 'Excel sync queued';
    if (syncStatus.state === 'partial_success') return 'S3 updated, Google Sheets sync skipped (check credentials)';
    if (syncStatus.state === 'success') return `Last synced ${syncStatus.lastSuccessAt ? new Date(syncStatus.lastSuccessAt).toLocaleString() : 'successfully'}`;
    if (syncStatus.state === 'error') return `Sync failed: ${syncStatus.lastError || 'unknown error'}`;
    return 'Sync idle';
  })();

  const syncBadgeClass = syncStatus?.state === 'error'
    ? 'bg-red-100 text-red-700 border-red-200'
    : syncStatus?.state === 'running' || syncStatus?.state === 'queued'
      ? 'bg-amber-100 text-amber-700 border-amber-200'
      : syncStatus?.state === 'partial_success'
        ? 'bg-blue-100 text-blue-700 border-blue-200'
        : 'bg-emerald-100 text-emerald-700 border-emerald-200';

  if (!isLiveMode) {
    return <div className="p-8 text-amber-700">Switch to <b>Live API</b> mode to use the Excel report editor.</div>;
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Driver Excel Report</h2>
          <p className="text-sm text-gray-500">Edit, update, delete customer rows and keep S3 + Google Sheets synchronized.</p>
          <div className={`mt-2 inline-flex items-center px-2.5 py-1 text-xs rounded-full border ${syncBadgeClass}`}>
            {syncLabel}
          </div>
          {uiMessage && <div className="mt-2 text-xs text-blue-700">{uiMessage}</div>}
        </div>
        <div className="flex items-center gap-2">
          <button disabled={actionKey === 'apply-view'} onClick={saveCurrentView} className="px-3 py-2 border rounded-lg text-sm disabled:opacity-50">Save View</button>
          <select
            className="px-3 py-2 border rounded-lg text-sm"
            value={selectedViewId}
            onChange={(e) => applySavedView(e.target.value)}
            disabled={actionKey === 'apply-view'}
          >
            <option value="">Saved Views</option>
            {savedViews.map((view) => (
              <option key={view.id} value={view.id}>{view.name}</option>
            ))}
          </select>
          <button disabled={!selectedViewId || actionKey === 'apply-view'} onClick={deleteSavedView} className="px-3 py-2 border rounded-lg text-sm text-red-600 disabled:opacity-50">Delete View</button>
          <label className="inline-flex items-center gap-1 text-xs text-gray-600 border rounded-lg px-2 py-2">
            <input type="checkbox" checked={autoAddNewVariables} onChange={(e) => setAutoAddNewVariables(e.target.checked)} />
            Auto-add new variables
          </label>
          <button disabled={actionKey === 'reset-order'} onClick={resetColumnOrder} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-1 disabled:opacity-50"><RotateCcw size={13} /> {actionKey === 'reset-order' ? 'Resetting...' : 'Reset Order'}</button>
          <button onClick={loadReport} className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm">Refresh</button>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-3 flex flex-wrap items-start gap-3">
        <div className="flex items-center gap-2">
          <input
            className="px-3 py-2 border rounded-lg text-sm min-w-[260px]"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name / phone / stage"
          />
          <button onClick={loadReport} className="px-3 py-2 border rounded-lg text-sm">Search</button>
        </div>

        <div className="ml-auto flex flex-wrap items-start gap-3">
          <div className="flex items-center gap-2">
            <input
              className="px-3 py-2 border rounded-lg text-sm"
              placeholder="New column label"
              value={newColumnLabel}
              onChange={(e) => setNewColumnLabel(e.target.value)}
            />
            <button disabled={actionKey === 'add-column'} onClick={addColumn} className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm flex items-center gap-1 disabled:opacity-50"><Plus size={14} /> {actionKey === 'add-column' ? 'Adding...' : 'Add Column'}</button>
          </div>

          <div className="min-w-[340px] border rounded-lg p-2 bg-gray-50">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-medium text-gray-700">Variable Columns</div>
              <div className="flex items-center gap-1">
                <button disabled={actionKey === 'add-recommended-variables'} onClick={addRecommendedVariables} className="px-2 py-1 bg-indigo-600 text-white rounded text-xs disabled:opacity-50">{actionKey === 'add-recommended-variables' ? 'Adding...' : 'Add Recommended'}</button>
                <button disabled={actionKey === 'add-selected-variables'} onClick={addSelectedVariables} className="px-2 py-1 bg-emerald-600 text-white rounded text-xs flex items-center gap-1 disabled:opacity-50"><CheckSquare size={12} /> {actionKey === 'add-selected-variables' ? 'Adding...' : 'Add Selected'}</button>
              </div>
            </div>
            <input
              className="w-full px-2 py-1.5 border rounded text-sm mb-2"
              placeholder="Filter variables by label/key"
              value={variableFilter}
              onChange={(e) => setVariableFilter(e.target.value)}
            />
            <div className="max-h-36 overflow-auto bg-white border rounded p-1 space-y-1">
              <div className="flex items-center justify-between px-2 py-1 border-b mb-1">
                <button className="text-[11px] text-blue-600" onClick={selectAllFilteredVariables}>Select all</button>
                <button className="text-[11px] text-gray-500" onClick={clearSelectedVariables}>Clear</button>
              </div>
              {filteredVariableOptions.length === 0 ? (
                <div className="text-xs text-gray-500 px-2 py-1">No variables found</div>
              ) : (
                filteredVariableOptions.map((option) => {
                  const stat = variableStats.get(option.key);
                  return (
                    <label key={option.key} className="flex items-start gap-2 px-2 py-1 rounded text-xs text-gray-700 hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={selectedVariableKeys.includes(option.key)}
                        onChange={(e) => toggleVariableSelection(option.key, e.target.checked)}
                      />
                      <span className="leading-4 flex-1">
                        <b>{option.label || option.key}</b>
                        <span className="block text-[11px] text-gray-500">{option.key} • Fill {stat?.fillRate ?? 0}% ({stat?.filledCount ?? 0}/{rows.length})</span>
                        {stat?.sampleValue && <span className="block text-[11px] text-gray-400 truncate">Sample: {stat.sampleValue}</span>}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
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
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={async () => {
                    if (!draggingColKey) return;
                    await reorderColumns(draggingColKey, col.key);
                    setDraggingColKey(null);
                  }}
                  onDragEnd={() => setDraggingColKey(null)}
                >
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="text-gray-400 cursor-grab active:cursor-grabbing"
                      title="Drag to reorder"
                      draggable
                      onDragStart={(e) => {
                        e.stopPropagation();
                        setDraggingColKey(col.key);
                      }}
                    >
                      <GripVertical size={13} className="text-gray-400" />
                    </button>
                    <span>{col.label}</span>
                    {!col.isCore && (
                      <>
                        <button onClick={() => moveColumn(col, 'up')} className="text-gray-500 hover:text-gray-900 disabled:opacity-50" title="Move column up" disabled={actionKey !== null}><ArrowUp size={13} /></button>
                        <button onClick={() => moveColumn(col, 'down')} className="text-gray-500 hover:text-gray-900 disabled:opacity-50" title="Move column down" disabled={actionKey !== null}><ArrowDown size={13} /></button>
                        <button onClick={() => renameColumn(col)} disabled={actionKey === `rename-${col.key}` || actionKey !== null} className="text-gray-500 hover:text-gray-900 disabled:opacity-50"><Pencil size={13} /></button>
                        <button onClick={() => deleteColumn(col)} disabled={actionKey === `delete-${col.key}` || actionKey !== null} className="text-red-500 hover:text-red-700 disabled:opacity-50"><X size={13} /></button>
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
                    const looksLikeLink = typeof value === 'string' && /^(https?:\/\/|\/showcase\/)/.test(value.trim());
                    return (
                      <td key={col.key} className="px-3 py-2 border-b align-top min-w-[160px]">
                        {isEditing ? (
                          <div className="flex items-center gap-2">
                            <input className="px-2 py-1 border rounded w-full" value={draftValue} onChange={(e) => setDraftValue(e.target.value)} />
                            <button onClick={saveCell} className="text-green-600"><Save size={14} /></button>
                            <button onClick={() => setEditingCell(null)} className="text-gray-500"><X size={14} /></button>
                          </div>
                        ) : (col.key.endsWith('_status')) ? (
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${
                            value === 'approved' ? 'bg-emerald-100 text-emerald-700' :
                            value === 'rejected' ? 'bg-red-100 text-red-700' :
                            value === 'under_review' ? 'bg-amber-100 text-amber-700' :
                            value === 'uploaded' ? 'bg-blue-100 text-blue-700' :
                            value === 'expired' ? 'bg-rose-100 text-rose-700' : 'bg-gray-100 text-gray-700'
                          }`}>{value || 'missing'}</span>
                        ) : (col.key.endsWith('_uploaded_at') || col.key === 'claimedAt') ? (
                          <span className="whitespace-pre-wrap break-words">{value ? new Date(value).toLocaleString() : '-'}</span>
                        ) : (looksLikeLink) ? (
                          value ? (
                            <a href={value} target="_blank" rel="noreferrer" className="text-blue-600 underline break-all">{value}</a>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )
                        ) : (
                          <button onClick={() => beginEdit(row.id, col, value)} disabled={!canEditRow(row)} className="text-left w-full disabled:opacity-60">
                            <span className="whitespace-pre-wrap break-words">{value === '' ? '-' : value}</span>
                          </button>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 border-b">
                    <div className="flex items-center gap-2">
                      {actor?.role !== 'admin' && !(row.ownerStaffEmail || '').toLowerCase() && (
                        <button onClick={() => claimLead(row.id)} disabled={actionKey !== null} className="text-blue-600 hover:text-blue-800 disabled:opacity-50 text-xs font-semibold">Collect</button>
                      )}
                      {((row.ownerStaffEmail || '').toLowerCase() === (actor?.email || '').toLowerCase() || actor?.role === 'admin') && row.ownerStaffEmail && (
                        <button onClick={() => releaseLead(row.id)} disabled={actionKey !== null} className="text-amber-600 hover:text-amber-800 disabled:opacity-50 text-xs font-semibold">Release</button>
                      )}
                      {actor?.role === 'admin' && (
                        <button onClick={() => deleteRow(row.id)} className="text-red-600 hover:text-red-800"><Trash2 size={16} /></button>
                      )}
                    </div>
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
