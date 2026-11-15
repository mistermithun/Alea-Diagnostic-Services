import React, { useCallback, useEffect, useState } from 'react';
import { Edit2, Plus, Search, Trash2, X } from 'lucide-react';
import { apiFetch, formatBDT } from '../lib/api.ts';
import type { DiagnosticTest, TestCategory } from '../types.ts';

interface EditableParam {
  name: string;
  unit: string;
  input_type: 'numeric' | 'text' | 'select';
  normal_text: string;
  default_value: string;
  select_options: string;
  abnormal_values: string;
  min_male: string;
  max_male: string;
  min_female: string;
  max_female: string;
  min_child: string;
  max_child: string;
}

const emptyParam = (): EditableParam => ({
  name: '',
  unit: '',
  input_type: 'numeric',
  normal_text: '',
  default_value: '',
  select_options: '',
  abnormal_values: '',
  min_male: '',
  max_male: '',
  min_female: '',
  max_female: '',
  min_child: '',
  max_child: '',
});

export const TestCatalogView: React.FC = () => {
  const [categories, setCategories] = useState<TestCategory[]>([]);
  const [tests, setTests] = useState<DiagnosticTest[]>([]);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('All');
  const [newCategoryName, setNewCategoryName] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Modal editor state
  const [editingTest, setEditingTest] = useState<DiagnosticTest | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formCategoryId, setFormCategoryId] = useState<number>(0);
  const [formCode, setFormCode] = useState('');
  const [formName, setFormName] = useState('');
  const [formPrice, setFormPrice] = useState('');
  const [formSampleType, setFormSampleType] = useState('Serum');
  const [formParams, setFormParams] = useState<EditableParam[]>([emptyParam()]);
  const [saving, setSaving] = useState(false);

  const loadCatalog = useCallback(async () => {
    try {
      const res = await apiFetch<{ categories: TestCategory[]; tests: DiagnosticTest[] }>(
        '/api/catalog'
      );
      setCategories(res.categories);
      setTests(res.tests);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load catalog.');
    }
  }, []);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const handleAddCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCategoryName.trim()) return;
    setError('');
    try {
      await apiFetch('/api/admin/categories', {
        method: 'POST',
        body: JSON.stringify({ name: newCategoryName.trim() }),
      });
      setNewCategoryName('');
      await loadCatalog();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add category.');
    }
  };

  const openCreateModal = () => {
    setEditingTest(null);
    setFormCategoryId(categories[0]?.id || 0);
    setFormCode('');
    setFormName('');
    setFormPrice('');
    setFormSampleType('Serum');
    setFormParams([emptyParam()]);
    setIsModalOpen(true);
  };

  const openEditModal = (t: DiagnosticTest) => {
    setEditingTest(t);
    setFormCategoryId(t.category_id);
    setFormCode(t.code);
    setFormName(t.name);
    setFormPrice(String(t.price));
    setFormSampleType(t.sample_type);
    setFormParams(
      t.parameters.length > 0
        ? t.parameters.map((p) => ({
            name: p.name,
            unit: p.unit || '',
            input_type: p.input_type || 'numeric',
            normal_text: p.normal_text || '',
            default_value: p.default_value || '',
            select_options: p.select_options || '',
            abnormal_values: p.abnormal_values || '',
            min_male: p.min_male !== null && p.min_male !== undefined ? String(p.min_male) : '',
            max_male: p.max_male !== null && p.max_male !== undefined ? String(p.max_male) : '',
            min_female: p.min_female !== null && p.min_female !== undefined ? String(p.min_female) : '',
            max_female: p.max_female !== null && p.max_female !== undefined ? String(p.max_female) : '',
            min_child: p.min_child !== null && p.min_child !== undefined ? String(p.min_child) : '',
            max_child: p.max_child !== null && p.max_child !== undefined ? String(p.max_child) : '',
          }))
        : [emptyParam()]
    );
    setIsModalOpen(true);
  };

  const toNumOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

  const handleSaveTest = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const payload = {
        category_id: Number(formCategoryId),
        code: formCode.trim(),
        name: formName.trim(),
        price: Number(formPrice || 0),
        sample_type: formSampleType.trim(),
        parameters: formParams
          .filter((p) => p.name.trim() !== '')
          .map((p) => ({
            name: p.name.trim(),
            unit: p.unit.trim(),
            input_type: p.input_type,
            normal_text: p.normal_text.trim(),
            default_value: p.default_value.trim(),
            select_options: p.select_options.trim(),
            abnormal_values: p.abnormal_values.trim(),
            min_male: toNumOrNull(p.min_male),
            max_male: toNumOrNull(p.max_male),
            min_female: toNumOrNull(p.min_female),
            max_female: toNumOrNull(p.max_female),
            min_child: toNumOrNull(p.min_child),
            max_child: toNumOrNull(p.max_child),
          })),
      };

      if (editingTest) {
        await apiFetch(`/api/admin/tests/${editingTest.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        setSuccess(`Updated "${payload.name}".`);
      } else {
        await apiFetch('/api/admin/tests', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setSuccess(`Added "${payload.name}" to catalog.`);
      }
      setIsModalOpen(false);
      await loadCatalog();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save test.');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteTest = async (t: DiagnosticTest) => {
    setError('');
    try {
      await apiFetch(`/api/admin/tests/${t.id}`, { method: 'DELETE' });
      setSuccess(`Removed "${t.name}" from active catalog.`);
      await loadCatalog();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete test.');
    }
  };

  const filteredTests = tests.filter((t) => {
    if (activeCategory !== 'All' && t.category_name !== activeCategory) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return t.name.toLowerCase().includes(q) || t.code.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Test Catalog & Reference Ranges</h1>
          <p className="text-sm text-slate-600 mt-0.5">
            Manage departments, test prices (BDT ৳), sub-parameters, units, and age/gender reference ranges.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreateModal}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-teal-600 rounded-lg hover:bg-teal-700 whitespace-nowrap shrink-0 self-start"
        >
          <Plus className="w-4 h-4" />
          Add New Test
        </button>
      </div>

      {error && <div className="p-3 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg">{error}</div>}
      {success && <div className="p-3 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg">{success}</div>}

      {/* Categories & Quick Add */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setActiveCategory('All')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap shrink-0 ${
              activeCategory === 'All' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            All ({tests.length})
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setActiveCategory(c.name)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap shrink-0 ${
                activeCategory === c.name ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>

        <form onSubmit={handleAddCategory} className="flex items-center gap-2">
          <input
            type="text"
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            placeholder="New department name..."
            className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
          />
          <button
            type="submit"
            className="px-3 py-1.5 text-xs font-medium text-slate-800 border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            + Add Dept
          </button>
        </form>
      </div>

      {/* Catalog Table */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search test code or name..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
          />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="py-2 pr-3 font-medium">Code</th>
                <th className="py-2 pr-3 font-medium">Test Name</th>
                <th className="py-2 pr-3 font-medium">Department</th>
                <th className="py-2 pr-3 font-medium">Sample Type</th>
                <th className="py-2 pr-3 font-medium text-center">Parameters</th>
                <th className="py-2 pr-3 font-medium text-right">Price (BDT)</th>
                <th className="py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {filteredTests.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50">
                  <td className="py-3 pr-3 font-mono text-xs font-semibold text-slate-700">{t.code}</td>
                  <td className="py-3 pr-3 font-semibold text-slate-900">{t.name}</td>
                  <td className="py-3 pr-3 text-xs text-slate-600">{t.category_name}</td>
                  <td className="py-3 pr-3 text-xs text-slate-600">{t.sample_type}</td>
                  <td className="py-3 pr-3 text-center font-mono tabular-nums text-xs text-slate-700">
                    {t.parameters.length}
                  </td>
                  <td className="py-3 pr-3 text-right font-mono tabular-nums font-bold text-slate-900">
                    {formatBDT(t.price)}
                  </td>
                  <td className="py-3 text-right">
                    <div className="inline-flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => openEditModal(t)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded-md hover:bg-slate-100 whitespace-nowrap"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteTest(t)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-red-700 border border-red-200 rounded-md hover:bg-red-50 whitespace-nowrap"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add / Edit Test Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 overflow-y-auto p-4 flex items-start justify-center">
          <div className="w-full max-w-4xl bg-white border border-slate-200 rounded-xl shadow-xl my-6 overflow-hidden">
            <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between">
              <h2 className="text-base font-semibold">
                {editingTest ? `Edit Test: ${editingTest.name}` : 'Create New Diagnostic Test'}
              </h2>
              <button type="button" onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveTest} className="p-6 space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                <div className="lg:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Test Name</label>
                  <input
                    type="text"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="e.g. Serum Electrolytes"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Department</label>
                  <select
                    value={formCategoryId}
                    onChange={(e) => setFormCategoryId(Number(e.target.value))}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                    required
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Test Code</label>
                  <input
                    type="text"
                    value={formCode}
                    onChange={(e) => setFormCode(e.target.value)}
                    placeholder="BIO-07"
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Price (BDT ৳)</label>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={formPrice}
                    onChange={(e) => setFormPrice(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-300 rounded-lg"
                    required
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Sample Type</label>
                  <input
                    type="text"
                    value={formSampleType}
                    onChange={(e) => setFormSampleType(e.target.value)}
                    placeholder="Whole Blood (EDTA), Serum, Urine..."
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    required
                  />
                </div>
              </div>

              {/* Sub-parameters & Age/Gender Ranges */}
              <div className="space-y-3 pt-2 border-t border-slate-200">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">Sub-Parameters & Reference Ranges</h3>
                    <p className="text-xs text-slate-500">
                      Configure numeric Male/Female/Child ranges for automatic Bold Red abnormal flagging.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setFormParams((prev) => [...prev, emptyParam()])}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-teal-700 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 whitespace-nowrap shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Parameter
                  </button>
                </div>

                <div className="space-y-3 max-h-[360px] overflow-y-auto pr-1">
                  {formParams.map((p, idx) => (
                    <div key={idx} className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
                      <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end">
                        <div className="sm:col-span-4">
                          <label className="block text-[11px] font-medium text-slate-600 mb-1">Parameter Name</label>
                          <input
                            type="text"
                            value={p.name}
                            onChange={(e) =>
                              setFormParams((prev) =>
                                prev.map((item, i) => (i === idx ? { ...item, name: e.target.value } : item))
                              )
                            }
                            placeholder="e.g. Hemoglobin"
                            className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
                            required
                          />
                        </div>
                        <div className="sm:col-span-2">
                          <label className="block text-[11px] font-medium text-slate-600 mb-1">Unit</label>
                          <input
                            type="text"
                            value={p.unit}
                            onChange={(e) =>
                              setFormParams((prev) =>
                                prev.map((item, i) => (i === idx ? { ...item, unit: e.target.value } : item))
                              )
                            }
                            placeholder="g/dL, mg/dL"
                            className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
                          />
                        </div>
                        <div className="sm:col-span-2">
                          <label className="block text-[11px] font-medium text-slate-600 mb-1">Input Type</label>
                          <select
                            value={p.input_type}
                            onChange={(e) =>
                              setFormParams((prev) =>
                                prev.map((item, i) =>
                                  i === idx ? { ...item, input_type: e.target.value as 'numeric' | 'text' | 'select' } : item
                                )
                              )
                            }
                            className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
                          >
                            <option value="numeric">Numeric</option>
                            <option value="select">Dropdown</option>
                            <option value="text">Text</option>
                          </select>
                        </div>
                        <div className="sm:col-span-2">
                          <label className="block text-[11px] font-medium text-slate-600 mb-1">Display Range Label</label>
                          <input
                            type="text"
                            value={p.normal_text}
                            onChange={(e) =>
                              setFormParams((prev) =>
                                prev.map((item, i) => (i === idx ? { ...item, normal_text: e.target.value } : item))
                              )
                            }
                            placeholder="e.g. 13.0 - 17.0"
                            className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
                          />
                        </div>
                        <div className="sm:col-span-1">
                          <label className="block text-[11px] font-medium text-slate-600 mb-1" title="Default value pre-filled on new test reports">
                            Default
                          </label>
                          <input
                            type="text"
                            value={p.default_value}
                            onChange={(e) =>
                              setFormParams((prev) =>
                                prev.map((item, i) => (i === idx ? { ...item, default_value: e.target.value } : item))
                              )
                            }
                            placeholder="Blank"
                            className="w-full px-2 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
                          />
                        </div>
                        <div className="sm:col-span-1 text-right">
                          <button
                            type="button"
                            onClick={() => setFormParams((prev) => prev.filter((_, i) => i !== idx))}
                            disabled={formParams.length === 1}
                            className="p-1.5 text-slate-400 hover:text-red-600 disabled:opacity-30"
                            aria-label="Remove parameter"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {p.input_type === 'numeric' ? (
                        <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
                          <div>
                            <label className="block text-[10px] text-slate-500 mb-0.5">Male Min</label>
                            <input
                              type="number"
                              step="any"
                              value={p.min_male}
                              onChange={(e) =>
                                setFormParams((prev) =>
                                  prev.map((item, i) => (i === idx ? { ...item, min_male: e.target.value } : item))
                                )
                              }
                              className="w-full px-2 py-1 text-xs font-mono border border-slate-300 rounded bg-white"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] text-slate-500 mb-0.5">Male Max</label>
                            <input
                              type="number"
                              step="any"
                              value={p.max_male}
                              onChange={(e) =>
                                setFormParams((prev) =>
                                  prev.map((item, i) => (i === idx ? { ...item, max_male: e.target.value } : item))
                                )
                              }
                              className="w-full px-2 py-1 text-xs font-mono border border-slate-300 rounded bg-white"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] text-slate-500 mb-0.5">Female Min</label>
                            <input
                              type="number"
                              step="any"
                              value={p.min_female}
                              onChange={(e) =>
                                setFormParams((prev) =>
                                  prev.map((item, i) => (i === idx ? { ...item, min_female: e.target.value } : item))
                                )
                              }
                              className="w-full px-2 py-1 text-xs font-mono border border-slate-300 rounded bg-white"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] text-slate-500 mb-0.5">Female Max</label>
                            <input
                              type="number"
                              step="any"
                              value={p.max_female}
                              onChange={(e) =>
                                setFormParams((prev) =>
                                  prev.map((item, i) => (i === idx ? { ...item, max_female: e.target.value } : item))
                                )
                              }
                              className="w-full px-2 py-1 text-xs font-mono border border-slate-300 rounded bg-white"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] text-slate-500 mb-0.5">Child Min (&lt;12Y)</label>
                            <input
                              type="number"
                              step="any"
                              value={p.min_child}
                              onChange={(e) =>
                                setFormParams((prev) =>
                                  prev.map((item, i) => (i === idx ? { ...item, min_child: e.target.value } : item))
                                )
                              }
                              className="w-full px-2 py-1 text-xs font-mono border border-slate-300 rounded bg-white"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] text-slate-500 mb-0.5">Child Max (&lt;12Y)</label>
                            <input
                              type="number"
                              step="any"
                              value={p.max_child}
                              onChange={(e) =>
                                setFormParams((prev) =>
                                  prev.map((item, i) => (i === idx ? { ...item, max_child: e.target.value } : item))
                                )
                              }
                              className="w-full px-2 py-1 text-xs font-mono border border-slate-300 rounded bg-white"
                            />
                          </div>
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <div>
                            <label className="block text-[10px] text-slate-500 mb-0.5">
                              Dropdown Options (comma-separated)
                            </label>
                            <input
                              type="text"
                              value={p.select_options}
                              onChange={(e) =>
                                setFormParams((prev) =>
                                  prev.map((item, i) => (i === idx ? { ...item, select_options: e.target.value } : item))
                                )
                              }
                              placeholder="Non-Reactive,Reactive"
                              className="w-full px-2 py-1 text-xs border border-slate-300 rounded bg-white"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] text-slate-500 mb-0.5">
                              Abnormal Flag Trigger Values (comma-separated)
                            </label>
                            <input
                              type="text"
                              value={p.abnormal_values}
                              onChange={(e) =>
                                setFormParams((prev) =>
                                  prev.map((item, i) => (i === idx ? { ...item, abnormal_values: e.target.value } : item))
                                )
                              }
                              placeholder="Reactive,Positive"
                              className="w-full px-2 py-1 text-xs border border-slate-300 rounded bg-white"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : editingTest ? 'Update Test' : 'Save Test'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
