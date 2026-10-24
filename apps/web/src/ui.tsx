import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addMargin, analyzePrices, extractShoeCode, formatCop, prepareOutgoingDescription, replacePriceCandidates, type OverlayPosition } from '@tenis/core';
import type { Settings } from '@tenis/core';
import { api } from './api.js';

type ImageCodeCandidate = { code: string; confidence: number; evidence: 'label' | 'mixed-code' | 'number-only' };
type ImageInspection = { ocrText: string; ocrConfidence: number; ocrError: string | null; codeCandidates: ImageCodeCandidate[]; detectedCode: string | null; codeConfidence: number; world: { detected: boolean; variant: string | null; confidence: number }; inspectedAt: string };
type MarkMode = 'original' | 'mark_all' | 'mark_code' | 'mark_world';
type Marking = { status: 'pending' | 'ready' | 'review'; mode: MarkMode | null; reason: string; manual: boolean };
type Image = { id: string; fileName: string; mimeType: string; sizeBytes: number; position: number; url: string; inspection: ImageInspection | null; marking: Marking };
type Publication = { groupId: string; groupName: string; status: 'queued' | 'in_progress' | 'submitted' | 'needs_review' | 'failed' | 'canceled'; updatedAt: string };
type Product = {
  id: string; title: string; raw_text: string; source_price_cop: number | null; final_price_cop: number | null;
  output_text: string | null; status: 'needs_review' | 'approved' | 'simulated'; created_at: string; updated_at: string;
  analysis: ReturnType<typeof analyzePrices>; images: Image[]; publications: Publication[];
  sessionId: string; session_name: string; supplierId: string | null; supplier_name: string | null;
  margin_cop_applied: number | null; box_margin_cop_applied: number | null; shoe_code: string | null; marker_text_applied: string | null;
  image_position: OverlayPosition | null; markedImageUrl: string;
};
type WhatsAppGroup = { id: string; name: string };
type ReceptionDiagnostics = { lastUpsertAt: string | null; lastUpsertType: 'notify' | 'append' | null; lastUpsertMessageCount: number; lastGroupMessageAt: string | null; lastGroupName: string | null; lastSupplierMessageAt: string | null; lastSupplierName: string | null; lastSupplierResult: 'processing' | 'stored' | 'duplicate' | 'pending' | 'older_message_skipped' | 'outside_recovery_window' | 'unsupported_message' | 'error' | null };
type ReceptionQueue = { recoveryRequestedGroups: number; recoveryMissingAnchors: number; recoveryFailedRequests: number; pendingCount: number; failedCount: number; recoveryStatus: 'idle' | 'waiting' | 'received' | 'unavailable'; recoveryStartedAt: string | null; recoveryFinishedAt: string | null; recoveryMessageCount: number; recoveryWarning: string | null; lastSupplierMessageAt: string | null; lastSupplierGroupJid: string | null; lastSupplierResult: string | null };
type ReceptionSchedule = { startTime: string; endTime: string; timeZone: string };
type Session = { id: string; name: string; status: 'disabled' | 'disconnected' | 'connecting' | 'qr' | 'connected' | 'logged_out'; qrDataUrl: string | null; lastError: string | null; reception?: ReceptionDiagnostics | null; receptionQueue: ReceptionQueue; receptionSchedule: ReceptionSchedule; targetGroupIds: string[]; sendIntervalMs: number; enabled: boolean; distributionStatus: 'stopped' | 'paused' | 'running' };
type Supplier = { id: string; sessionId: string; sourceGroupId: string; sourceGroupName: string | null; name: string; priceMarginCop: number; boxMarginCop: number; markerText: string; defaultPosition: OverlayPosition };
type Distribution = { realSendsEnabled: boolean; connected: boolean; status: 'stopped' | 'paused' | 'running'; queue: Record<string, number> };
type ApplicationLog = { id: string; sessionId: string; sessionName: string; level: 'info' | 'warning' | 'error'; category: string; action: string; entityType: string; entityId: string; entityName: string | null; message: string; details: Record<string, unknown>; createdAt: string };
type CatalogStatusFilter = 'all' | 'review' | 'prepared' | 'sending' | 'sent';
const POSITIONS: Array<{ id: OverlayPosition; label: string }> = [
  { id: 'top_left', label: 'Superior izquierda' }, { id: 'top_right', label: 'Superior derecha' },
  { id: 'bottom_left', label: 'Inferior izquierda' }, { id: 'bottom_right', label: 'Inferior derecha' },
];

function json(body: unknown): RequestInit { return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
function timeLabel(value: string) { return new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function pendingTargetIds(product: Product, targets: string[]) {
  return targets.filter((id) => !product.publications.some((publication) => publication.groupId === id && publication.status === 'submitted'));
}
function hasPendingDistribution(product: Product, targets: string[]) {
  return !product.publications.some((publication) => ['queued', 'in_progress', 'needs_review'].includes(publication.status))
    && (product.publications.length === 0 || pendingTargetIds(product, targets).length > 0);
}
function canSelectProduct(product: Product, targets: string[]) {
  return ['approved', 'simulated'].includes(product.status)
    && hasPendingDistribution(product, targets) && product.images.length > 0
    && product.images.every((image) => image.marking.status === 'ready')
    && product.margin_cop_applied !== null
    && (!product.analysis.candidates.some((candidate) => candidate.kind === 'box') || product.box_margin_cop_applied !== null);
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState('main');
  const [whatsApp, setWhatsApp] = useState<Session | null>(null);
  const [groups, setGroups] = useState<WhatsAppGroup[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierFilter, setSupplierFilter] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<CatalogStatusFilter>('all');
  const [selectedImageIds, setSelectedImageIds] = useState<string[]>([]);
  const [sendingBatch, setSendingBatch] = useState(false);
  const [sendingBatchIds, setSendingBatchIds] = useState<string[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [settings, setSettings] = useState<Settings>({ marginCop: 10000, targetGroups: [] });
  const [logs, setLogs] = useState<ApplicationLog[]>([]);
  const [distribution, setDistribution] = useState<Distribution>({ realSendsEnabled: false, connected: false, status: 'stopped', queue: {} });
  const [busy, setBusy] = useState(false);
  const [deletingProducts, setDeletingProducts] = useState(false);
  const catalogOperation = useRef(0);
  const [message, setMessage] = useState('');
  const [bulkSkipped, setBulkSkipped] = useState<string[]>([]);
  const [approvalProducts, setApprovalProducts] = useState<Product[] | null>(null);
  const [pendingEditIds, setPendingEditIds] = useState<string[]>([]);
  const trackDraft = useCallback((id: string, dirty: boolean) => {
    setPendingEditIds((current) => dirty ? current.includes(id) ? current : [...current, id] : current.includes(id) ? current.filter((item) => item !== id) : current);
  }, []);
  function hasUnsavedChanges(items: Product[]) {
    if (!items.some((item) => pendingEditIds.includes(item.id))) return false;
    setMessage('Guarda los cambios de descripción o fotografía antes de aprobar o enviar el lote.');
    return true;
  }
  const [tab, setTab] = useState<'products' | 'activity' | 'connection' | 'suppliers' | 'settings'>('products');

  async function refresh() {
    const [nextSessions, nextSettings] = await Promise.all([
      api<Session[]>('/sessions'), api<Settings>('/settings'),
    ]);
    setSessions(nextSessions);
    const activeId = nextSessions.some((account) => account.id === sessionId) ? sessionId : nextSessions[0]?.id ?? 'main';
    if (activeId !== sessionId) setSessionId(activeId);
    const suffix = `?sessionId=${encodeURIComponent(activeId)}`;
    const [account, nextGroups, nextSuppliers, nextProducts, nextDistribution, nextLogs] = await Promise.all([
      api<Session>(`/sessions/${encodeURIComponent(activeId)}`),
      api<WhatsAppGroup[]>(`/sessions/${encodeURIComponent(activeId)}/groups?cached=true`),
      api<Supplier[]>(`/sessions/${encodeURIComponent(activeId)}/providers`),
      api<Product[]>(`/products${suffix}`),
      api<Distribution>(`/distribution${suffix}`),
      api<ApplicationLog[]>(`/logs?sessionId=${encodeURIComponent(activeId)}&limit=300`),
    ]);
    setWhatsApp(account); setGroups(nextGroups); setSuppliers(nextSuppliers); setProducts(nextProducts); setDistribution(nextDistribution);
    setSettings(nextSettings); setLogs(nextLogs);
  }
  useEffect(() => { refresh().catch((error) => setMessage(error.message)); }, [sessionId]);
  useEffect(() => {
    const delay = tab === 'connection' ? 1500 : 3000;
    const timer = window.setInterval(() => {
      if (tab === 'connection') {
        api<Session[]>(`/sessions`).then((items) => setSessions(items));
        api<Session>(`/sessions/${encodeURIComponent(sessionId)}`).then(setWhatsApp).catch(() => undefined);
      }
      if (tab === 'products') {
        api<Session[]>(`/sessions`).then((items) => setSessions(items));
        Promise.all([api<Product[]>(`/products?sessionId=${encodeURIComponent(sessionId)}`), api<Distribution>(`/distribution?sessionId=${encodeURIComponent(sessionId)}`)]).then(([items, state]) => { setProducts(items); setDistribution(state); }).catch(() => undefined);
      }
      if (tab === 'activity') api<ApplicationLog[]>(`/logs?sessionId=${encodeURIComponent(sessionId)}&limit=300`).then(setLogs).catch(() => undefined);
    }, delay);
    return () => window.clearInterval(timer);
  }, [tab, sessionId]);

  const scopedProducts = useMemo(() => supplierFilter ? products.filter((product) => product.supplierId === supplierFilter) : products, [products, supplierFilter]);
  const supplierCounts = useMemo(() => new Map(suppliers.map((supplier) => [supplier.id, products.filter((product) => product.supplierId === supplier.id).length])), [products, suppliers]);
  const targetIds = whatsApp?.targetGroupIds ?? [];
  const targetGroups = targetIds.map((id) => groups.find((group) => group.id === id) ?? { id, name: id });
  const counts = useMemo(() => ({
    all: scopedProducts.length,
    review: scopedProducts.filter((product) => product.status === 'needs_review' || product.images.some((image) => image.marking.status !== 'ready') || product.publications.some((publication) => publication.status === 'needs_review')).length,
    prepared: scopedProducts.filter((product) => canSelectProduct(product, targetIds)).length,
    approvedAll: scopedProducts.filter((product) => ['approved', 'simulated'].includes(product.status) && hasPendingDistribution(product, targetIds)).length,
    sent: scopedProducts.filter((product) => product.publications.some((publication) => publication.status === 'submitted')).length,
    queued: scopedProducts.filter((product) => product.publications.some((publication) => publication.status === 'queued')).length,
    inProgress: scopedProducts.filter((product) => product.publications.some((publication) => publication.status === 'in_progress')).length,
    uncertain: scopedProducts.filter((product) => product.publications.some((publication) => publication.status === 'needs_review')).length,
    sending: scopedProducts.filter((product) => product.publications.some((publication) => ['queued', 'in_progress'].includes(publication.status))).length,
  }), [scopedProducts, targetIds]);
  const activeSession = sessions.find((item) => item.id === sessionId);
  const visibleProducts = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('es-CO');
    return scopedProducts.filter((product) => {
      const matchesSearch = !needle || [product.title, product.raw_text, product.output_text ?? '', product.shoe_code ?? '', product.supplier_name ?? '']
        .some((value) => value.toLocaleLowerCase('es-CO').includes(needle));
      const hasSent = product.publications.some((publication) => publication.status === 'submitted');
      const hasActivity = product.publications.some((publication) => ['queued', 'in_progress'].includes(publication.status));
      const matchesStatus = statusFilter === 'all'
        || statusFilter === 'review' && (product.status === 'needs_review' || product.images.some((image) => image.marking.status !== 'ready') || product.publications.some((publication) => publication.status === 'needs_review'))
        || statusFilter === 'prepared' && canSelectProduct(product, targetIds)
        || statusFilter === 'sending' && hasActivity
        || statusFilter === 'sent' && hasSent;
      return matchesSearch && matchesStatus;
    });
  }, [scopedProducts, search, statusFilter, targetIds]);
  const selectedImages = products.flatMap((product) => product.images.filter((image) => selectedImageIds.includes(image.id)));
  const selectedProducts = scopedProducts.filter((product) => canSelectProduct(product, targetIds) && product.images.every((image) => selectedImageIds.includes(image.id)));
  const visibleImageIds = visibleProducts.flatMap((product) => product.images.map((image) => image.id));
  function selectImages(ids: string[], checked: boolean) {
    setSelectedImageIds((current) => checked ? [...new Set([...current, ...ids])] : current.filter((id) => !ids.includes(id)));
  }
  const destinationNames = whatsApp?.targetGroupIds.map((id) => groups.find((group) => group.id === id)?.name ?? id) ?? [];
  const progressProducts = sendingBatchIds.length ? products.filter((product) => sendingBatchIds.includes(product.id)) : scopedProducts;
  const publicationProgress = progressProducts.reduce((summary, product) => {
    for (const publication of product.publications) {
      if (publication.status === 'submitted') summary.done += 1;
      else if (publication.status === 'queued' || publication.status === 'in_progress') summary.active += 1;
    }
    return summary;
  }, { done: 0, active: 0 });
  const progressTotal = sendingBatchIds.length ? sendingBatchIds.length * destinationNames.length : publicationProgress.done + publicationProgress.active;

  async function action(run: () => Promise<unknown>, success?: string) {
    const operation = catalogOperation.current;
    setBusy(true); setMessage(''); setBulkSkipped([]);
    try { await run(); if (operation !== catalogOperation.current) return; await refresh(); if (success) setMessage(success); }
    catch (error) { if (operation === catalogOperation.current) setMessage(error instanceof Error ? error.message : 'No se pudo completar la operación.'); }
    finally { if (operation === catalogOperation.current) setBusy(false); }
  }
  async function saveSupplier(supplier: Omit<Supplier, 'id'|'sessionId'|'sourceGroupName'>, id?: string) {
    setBusy(true); setMessage('');
    try {
      const saved = await api<Supplier & { restored?: boolean }>(id ? `/providers/${id}` : `/sessions/${sessionId}/providers`, { method: id ? 'PUT' : 'POST', ...json(supplier) });
      const provider = { ...saved, sessionId, sourceGroupName: groups.find((group) => group.id === saved.sourceGroupId)?.name ?? null };
      setSuppliers((current) => [...current.filter((item) => item.id !== saved.id), provider].sort((a, b) => a.name.localeCompare(b.name, 'es')));
      setMessage(id ? 'Reglas del proveedor actualizadas. Los productos existentes conservan su margen.' : saved.restored ? 'Proveedor reactivado. Las reglas nuevas se aplicarán a publicaciones nuevas; los productos existentes conservan su margen.' : 'Proveedor agregado; las publicaciones nuevas aparecerán en el catálogo.');
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No se pudo guardar el proveedor.');
      return false;
    } finally { setBusy(false); }
  }
  async function createSession() {
    const name = window.prompt('Nombre para la nueva cuenta de WhatsApp:');
    if (!name?.trim()) return;
    await action(async () => {
      const created = await api<{ id: string }>('/sessions', { method: 'POST', ...json({ name }) });
      setSessionId(created.id); setSupplierFilter(''); setTab('connection');
    }, 'Cuenta creada. Conecta su sesión para consultar sus grupos.');
  }
  function openApproveAll() {
    if (hasUnsavedChanges(scopedProducts)) return;
    const items = scopedProducts.filter((product) => !product.publications.some((publication) => ['queued', 'in_progress', 'submitted', 'needs_review'].includes(publication.status)));
    if (!items.length) { setMessage('No hay productos pendientes de aprobar fuera de distribución.'); return; }
    setApprovalProducts(items);
  }
  async function approveAll(items: BulkApprovalItem[]) {
    setBusy(true);
    try {
      const result = await api<{ productCount: number; resolvedImages: number }>('/products/approve-all', { method: 'POST', ...json({ sessionId, supplierId: supplierFilter || null, products: items }) });
      await refresh(); setApprovalProducts(null);
      setMessage(`Aprobación completa: ${result.productCount} productos y ${result.resolvedImages} fotos resueltas. Puedes revisar las vistas previas antes de enviar.`);
    } finally { setBusy(false); }
  }
  async function sendProduct(product: Product) {
    if (hasUnsavedChanges([product])) return;
    const destinations = pendingTargetIds(product, targetIds).map((id) => groups.find((group) => group.id === id)?.name ?? id);
    const interval = whatsApp?.sendIntervalMs ?? 10000;
    if (busy || sendingBatch || !window.confirm(`Cuenta: ${activeSession?.name ?? product.session_name}\nProducto: ${product.title || 'Sin nombre'}\nFotografías: ${product.images.length}\nDestinos (${destinations.length}): ${destinations.join(', ')}\nPausa entre fotos: ${Math.round(interval / 1000)} s\n\n¿Confirmas el envío real?`)) return;
    await action(() => api(`/products/${product.id}/send`, { method: 'POST' }));
  }
  async function sendAll() {
    const operation = catalogOperation.current;
    const readyForBatch = scopedProducts.filter((product) => ['approved', 'simulated'].includes(product.status) && hasPendingDistribution(product, targetIds));
    if (hasUnsavedChanges(readyForBatch)) return;
    const selected = readyForBatch.length;
    const destinations = whatsApp?.targetGroupIds.map((id) => groups.find((group) => group.id === id)?.name ?? id) ?? [];
    const provider = supplierFilter ? suppliers.find((supplier) => supplier.id === supplierFilter)?.name : 'todos los proveedores';
    const imageMessages = readyForBatch.reduce((total, product) => total + product.images.length * pendingTargetIds(product, targetIds).length, 0);
    const interval = whatsApp?.sendIntervalMs ?? 10000;
    const blocked = readyForBatch.filter((product) => !canSelectProduct(product, targetIds)).length;
    const names = readyForBatch.slice(0, 8).map((product) => `• ${product.title || 'Sin nombre'}`).join('\n');
    const more = readyForBatch.length > 8 ? `\n• y ${readyForBatch.length - 8} más` : '';
    if (sendingBatch || !selected || !window.confirm(`Cuenta: ${activeSession?.name ?? '—'}\nProductos (${selected}):\n${names}${more}\n\nFotografías a enviar en total: ${imageMessages}\nProveedor: ${provider}\nDestinos (${destinations.length}): ${destinations.join(', ')}\nSolo se enviará a los destinos pendientes de cada producto.\nPausa entre fotos: ${Math.round(interval / 1000)} s${blocked ? `\n\n${blocked} referencias con fotos pendientes, revisión o reglas incompletas se omitirán y aparecerán en el resultado.` : ''}\n\n¿Confirmas el envío real?`)) return;
    setSendingBatchIds(readyForBatch.map((product) => product.id));
    setSendingBatch(true);
    await action(async () => {
      const result = await api<{ message: string; skippedErrors: string[] }>('/products/send-all', { method: 'POST', ...json({ sessionId, supplierId: supplierFilter || null }) });
      if (operation !== catalogOperation.current) return;
      setMessage(result.message);
      setBulkSkipped(result.skippedErrors);
    });
    setSendingBatch(false);
    setSendingBatchIds([]);
  }
  async function sendSelected() {
    const operation = catalogOperation.current;
    if (hasUnsavedChanges(selectedProducts)) return;
    const ids = selectedProducts.map((product) => product.id);
    const imageMessages = selectedProducts.reduce((total, product) => total + product.images.length * pendingTargetIds(product, targetIds).length, 0);
    const interval = whatsApp?.sendIntervalMs ?? 10000;
    const names = selectedProducts.slice(0, 8).map((product) => `• ${product.title || 'Sin nombre'}`).join('\n');
    const more = selectedProducts.length > 8 ? `\n• y ${selectedProducts.length - 8} más` : '';
    if (!ids.length || sendingBatch || !window.confirm(`Cuenta: ${activeSession?.name ?? '—'}\nProductos seleccionados (${ids.length}):\n${names}${more}\n\nFotografías a enviar en total: ${imageMessages}\nDestinos (${destinationNames.length}): ${destinationNames.join(', ')}\nPausa entre fotos: ${Math.round(interval / 1000)} s\n\n¿Enviar las referencias preparadas seleccionadas solo a sus destinos pendientes?`)) return;
    setSendingBatch(true); setSendingBatchIds(ids); setBusy(true); setMessage(''); setBulkSkipped([]);
    try {
      const result = await api<{ message: string; skippedErrors: string[] }>('/products/send-all', { method: 'POST', ...json({ sessionId, supplierId: supplierFilter || null, productIds: ids }) });
      if (operation !== catalogOperation.current) return;
      setMessage(result.message); setBulkSkipped(result.skippedErrors); setSelectedImageIds([]);
      await refresh();
    } catch (error) { if (operation === catalogOperation.current) setMessage(error instanceof Error ? error.message : 'No se pudo enviar la selección.'); }
    finally { if (operation === catalogOperation.current) { setBusy(false); setSendingBatch(false); setSendingBatchIds([]); } }
  }
  async function deleteSelectedPhotos(imageIds = selectedImages.map((image) => image.id)) {
    if (deletingProducts || !imageIds.length) return;
    setDeletingProducts(true); setMessage('Eliminando las fotos seleccionadas…'); setBulkSkipped([]);
    try {
      const result = await api<{ imageCount: number; fileErrors: number }>(`/sessions/${encodeURIComponent(sessionId)}/photos`, { method: 'DELETE', ...json({ imageIds }) });
      setSelectedImageIds((current) => current.filter((id) => !imageIds.includes(id)));
      const affected = products.filter((product) => product.images.some((image) => imageIds.includes(image.id))).map((product) => product.id);
      setPendingEditIds((current) => current.filter((id) => !affected.includes(id)));
      await refresh();
      setMessage(`Se ${result.imageCount === 1 ? 'eliminó 1 foto seleccionada' : `eliminaron ${result.imageCount} fotos seleccionadas`}.${result.fileErrors ? ' Algunos archivos locales no se pudieron borrar.' : ''}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No se pudieron eliminar las fotos seleccionadas.');
    } finally {
      setDeletingProducts(false);
    }
  }
  async function deleteAllProducts() {
    if (deletingProducts || !products.length) return;
    catalogOperation.current += 1;
    setDeletingProducts(true); setBusy(true); setMessage('Deteniendo envíos y eliminando todos los productos…'); setBulkSkipped([]);
    try {
      const result = await api<{ productCount: number; fileErrors: number }>(`/sessions/${encodeURIComponent(sessionId)}/products`, { method: 'DELETE' });
      setSelectedImageIds([]); setPendingEditIds([]); setSendingBatchIds([]);
      setSupplierFilter(''); setSearch(''); setStatusFilter('all');
      await refresh();
      setMessage(`Envíos detenidos. Se eliminaron ${result.productCount} productos de la cuenta.${result.fileErrors ? ' Algunos archivos locales no se pudieron borrar.' : ''}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No se pudieron eliminar todos los productos.');
    } finally {
      setDeletingProducts(false); setBusy(false); setSendingBatch(false); setSendingBatchIds([]);
    }
  }
  async function refreshGroups() {
    const [account, nextGroups] = await Promise.all([api<Session>(`/sessions/${encodeURIComponent(sessionId)}`), api<WhatsAppGroup[]>(`/sessions/${encodeURIComponent(sessionId)}/groups`)]);
    setWhatsApp(account); setGroups(nextGroups);
  }

  return <div className="shell">
    <header className="topbar">
      <a className="brand" href="#inicio" aria-label="Mincho Sport, inicio"><span className="brand-mark"><img src="/mincho-sport.png" alt="" /></span><span className="brand-lockup"><strong>MINCHO <em>SPORT</em></strong><small>Mundo de las Zapatillas</small></span></a>
      <div className="topbar-right"><span className="local-indicator"><i /> Solo en este computador</span><span className="operator-badge" title="Panel del operador">MS</span></div>
    </header>
    <aside className="rail" aria-label="Navegación principal">
      <div className="rail-heading">ESPACIO DE TRABAJO</div>
      <button className={tab === 'products' ? 'rail-button active' : 'rail-button'} onClick={() => setTab('products')} aria-label="Productos" title="Productos" aria-current={tab === 'products' ? 'page' : undefined}><span aria-hidden="true">▦</span><span>Productos</span></button>
      <button className={tab === 'activity' ? 'rail-button active' : 'rail-button'} onClick={() => setTab('activity')} aria-label="Actividad" title="Actividad" aria-current={tab === 'activity' ? 'page' : undefined}><span aria-hidden="true">≋</span><span>Actividad</span></button>
      <button className={tab === 'connection' ? 'rail-button active' : 'rail-button'} onClick={() => setTab('connection')} aria-label="Cuentas y conexión" title="Cuentas y conexión" aria-current={tab === 'connection' ? 'page' : undefined}><span aria-hidden="true">◉</span><span>Cuentas</span></button>
      <button className={tab === 'suppliers' ? 'rail-button active' : 'rail-button'} onClick={() => setTab('suppliers')} aria-label="Proveedores" title="Proveedores" aria-current={tab === 'suppliers' ? 'page' : undefined}><span aria-hidden="true">◇</span><span>Proveedores</span></button>
      <button className={tab === 'settings' ? 'rail-button active' : 'rail-button'} onClick={() => setTab('settings')} aria-label="Configuración" title="Configuración" aria-current={tab === 'settings' ? 'page' : undefined}><span aria-hidden="true">⚙</span><span>Ajustes</span></button>
      <div className="rail-bottom"><span className={`connection-dot ${whatsApp?.status === 'connected' ? 'connected' : ''}`} /><span><strong>{whatsApp?.status === 'connected' ? 'WhatsApp conectado' : 'WhatsApp desconectado'}</strong><small>{activeSession?.name ?? 'Cuenta activa'}</small></span></div>
    </aside>
    <main className="main" id="inicio">
      <div className="page-heading">
        <div><div className="eyebrow">OPERACIÓN LOCAL <span>·</span> {tab === 'connection' ? 'BAILEYS EXPERIMENTAL' : distribution.realSendsEnabled ? 'ENVÍO MANUAL' : 'CATÁLOGO LOCAL'}</div><h1>{tab === 'products' ? 'Catálogo de productos' : tab === 'activity' ? 'Historial de actividad' : tab === 'connection' ? 'Cuentas de WhatsApp' : tab === 'suppliers' ? 'Reglas por proveedor' : 'Configuración'}</h1><p>{tab === 'products' ? 'Las fotos y descripciones llegan desde los grupos proveedor seleccionados y se conservan al reiniciar.' : tab === 'activity' ? 'Sigue la recepción, preparación, conexión y estado de los envíos.' : tab === 'connection' ? 'Cada número conserva su sesión y sus grupos de forma independiente.' : tab === 'suppliers' ? 'Define margen, marca y posición para cada grupo proveedor.' : 'Opciones de ejecución local y seguridad.'}</p></div>
        <div className="heading-controls"><label className="account-picker"><span>CUENTA ACTIVA</span><select value={sessionId} disabled={busy || sendingBatch || deletingProducts} onChange={(event) => { setSessionId(event.target.value); setSupplierFilter(''); setSelectedImageIds([]); }} aria-label="Cuenta activa">{sessions.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><button className="secondary-button" disabled={busy || deletingProducts} onClick={createSession}>＋ Nueva cuenta</button><div className={`mode-pill ${distribution.realSendsEnabled && distribution.connected ? 'mode-ready' : ''}`}><span className="mode-icon">◈</span><span>{distribution.realSendsEnabled ? `Envío real ${distribution.connected ? 'disponible' : '· conecta WhatsApp'}` : 'Envío real deshabilitado'}</span></div></div>
      </div>
      <div className="policy-note"><span className="note-icon">i</span><span><strong>{tab === 'connection' ? 'Conector experimental.' : 'Revisión antes de enviar.'}</strong> {tab === 'connection' ? 'Baileys no es una API oficial y puede dejar de funcionar o ocasionar restricciones. Usa grupos propios o autorizados.' : distribution.realSendsEnabled ? 'Los precios dudosos requieren revisión. Cada envío usa una copia marcada y una configuración congelada al prepararlo; los envíos inciertos se detienen para conciliación.' : 'El envío real está deshabilitado. Configura APP_MODE=experimental, WHATSAPP_ENABLED=true y WHATSAPP_SEND_ENABLED=true en .env y reinicia.'}</span></div>
      {message && <div className="toast" role="status"><span>{message}</span><button onClick={() => setMessage('')} aria-label="Cerrar aviso">×</button></div>}
      {bulkSkipped.length > 0 && <details className="bulk-skipped"><summary>{bulkSkipped.length} referencias pendientes o no enviadas · ver detalles</summary><ul>{bulkSkipped.map((entry, index) => <li key={`${entry}-${index}`}>{entry}</li>)}</ul></details>}

      {tab === 'products' ? <>
        <section className="distribution-context" aria-label="Resumen de la configuración de envío">
          <div className="distribution-context-main"><span className="context-icon">↗</span><div><strong>Configuración de envío</strong><span>Cuenta: {activeSession?.name ?? '—'} <i>·</i> Pausa: {Math.round((whatsApp?.sendIntervalMs ?? 10000) / 1000)} s entre fotos</span></div></div>
          <div className="destination-chips"><span className="destination-label">DESTINOS</span>{destinationNames.length ? destinationNames.map((name) => <span className="destination-chip" key={name}>{name}</span>) : <span className="destination-empty">Aún no hay grupos seleccionados</span>}</div>
          <button className="secondary-button context-edit" disabled={sendingBatch} onClick={() => setTab('connection')}>{destinationNames.length ? 'Editar destinos' : 'Configurar destinos'} <span>→</span></button>
        </section>
        {activeSession?.receptionQueue.pendingCount ? <div className="inbox-pending" role="status"><strong>{activeSession.receptionQueue.pendingCount} publicación(es) pendientes de procesar</strong><span>Se están incorporando al catálogo. La recepción en vivo permanece activa a cualquier hora.</span><button className="secondary-button" onClick={() => setTab('connection')}>Ver recepción</button></div> : null}
        {activeSession?.receptionQueue.failedCount ? <div className="inbox-failed" role="alert"><strong>{activeSession.receptionQueue.failedCount} publicación(es) con error de recepción</strong><span>Abre Cuentas para revisar el estado y consulta Actividad para ver el detalle.</span><button className="secondary-button" onClick={() => setTab('activity')}>Ver actividad</button></div> : null}
        {(sendingBatch || counts.queued > 0 || counts.inProgress > 0 || counts.uncertain > 0) && <div className={`send-progress ${counts.uncertain ? 'has-uncertain' : ''}`} role="status"><span className="progress-pulse" /><span><strong>{sendingBatch ? `Envío en curso · ${publicationProgress.done} de ${progressTotal} publicaciones aceptadas` : counts.inProgress ? `${counts.inProgress} referencias enviándose` : counts.queued ? `${counts.queued} referencias en cola` : `${counts.uncertain} referencias requieren conciliación`}</strong><small>{counts.uncertain ? 'Revisa esos grupos antes de volver a intentar.' : `Los estados se actualizan automáticamente. “Aceptado” indica que Baileys procesó el envío; no confirma entrega al destinatario.`}</small></span>{!sendingBatch && progressTotal > 0 && <span className="progress-count">{publicationProgress.done} / {progressTotal}</span>}</div>}
        <section className="stats" aria-label="Resumen del catálogo"><Stat label="Referencias" value={counts.all} detail="en esta cuenta y filtro" symbol="▦" /><Stat label="Por revisar" value={counts.review} detail="requieren tu decisión" symbol="◷" accent /><Stat label="Preparadas" value={counts.prepared} detail="listas para enviar" symbol="↗" /><Stat label="Enviadas" value={counts.sent} detail="confirmadas por Baileys" symbol="✓" /></section>
        <section className="catalog-panel supplier-catalog">
          <div className="catalog-header"><div><span className="panel-kicker">FOTOS Y DESCRIPCIONES RECIBIDAS</span><h2>Productos recibidos <span className="count-badge">{counts.all}</span></h2></div><div className="catalog-actions"><button className="primary-button" disabled={busy || deletingProducts || sendingBatch || !scopedProducts.length} onClick={openApproveAll}>Aprobar TODO</button><label className="filter-select"><span>Proveedor</span><select value={supplierFilter} onChange={(event) => { setSelectedImageIds([]); setSupplierFilter(event.target.value); }}><option value="">Todos ({products.length})</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name} ({supplierCounts.get(supplier.id) ?? 0})</option>)}</select></label><button className="secondary-button bulk-send-button delete-product-button" disabled={deletingProducts || !selectedImages.length} onClick={() => void deleteSelectedPhotos()}>{deletingProducts ? 'Eliminando fotos…' : selectedImages.length === 1 ? 'Eliminar foto seleccionada' : `Eliminar fotos seleccionadas (${selectedImages.length})`}</button><button className="secondary-button bulk-send-button delete-product-button" disabled={deletingProducts || !products.length} title="Detener los envíos y eliminar todos los productos de la cuenta activa, sin aplicar filtros ni selección" onClick={() => void deleteAllProducts()}>Eliminar todos</button>{counts.approvedAll > 0 && <button className="secondary-button bulk-send-button" disabled={busy || deletingProducts || sendingBatch || !distribution.realSendsEnabled || !distribution.connected || !(whatsApp?.targetGroupIds.length)} onClick={sendAll}><span>Enviar aprobados ({counts.approvedAll})</span><span>↗</span></button>}<button className="icon-button" onClick={() => refresh().catch((error) => setMessage(error.message))} title="Actualizar productos">↻</button></div></div>
          <div className="catalog-tools">
            <label className="catalog-search"><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por código, nombre o descripción" aria-label="Buscar productos por código, nombre o descripción" /><button type="button" onClick={() => setSearch('')} aria-label="Limpiar búsqueda" disabled={!search}>×</button></label>
            <div className="catalog-filter-row"><div className="status-filters" role="group" aria-label="Filtrar productos por estado">{([['all','Todos',counts.all],['review','Por revisar',counts.review],['prepared','Listos',counts.prepared],['sending','En cola',counts.sending],['sent','Enviados',counts.sent]] as const).map(([id,label,count]) => <button key={id} type="button" className={`status-filter ${statusFilter === id ? 'active' : ''}`} aria-pressed={statusFilter === id} onClick={() => setStatusFilter(id)}>{label}<span>{count}</span></button>)}</div>
              <div className="selection-actions"><button type="button" className="select-visible" disabled={!visibleImageIds.length || deletingProducts} onClick={() => selectImages(visibleImageIds, !visibleImageIds.every((id) => selectedImageIds.includes(id)))}>{visibleImageIds.length > 0 && visibleImageIds.every((id) => selectedImageIds.includes(id)) ? 'Quitar selección visible' : 'Seleccionar fotos visibles'}</button><span className="selection-count">{selectedImages.length} {selectedImages.length === 1 ? 'foto seleccionada' : 'fotos seleccionadas'}</span><button type="button" className="primary-button selected-send-button" title="Se envían las referencias listas que tienen todas sus fotos seleccionadas" disabled={busy || deletingProducts || sendingBatch || !selectedProducts.length || !distribution.realSendsEnabled || !distribution.connected || !destinationNames.length} onClick={() => void sendSelected()}>{sendingBatch ? 'Enviando selección…' : `Enviar referencias completas (${selectedProducts.length})`} <span>↗</span></button></div>
            </div>
          </div>
          {scopedProducts.length === 0 ? <div className="empty-state"><div className="empty-illustration">▱</div><h3>Aún no hay publicaciones recibidas</h3><p>{!distribution.connected ? 'Conecta la cuenta de WhatsApp para recibir publicaciones nuevas.' : suppliers.length === 0 ? 'Configura un grupo proveedor y su ganancia antes de iniciar la recepción.' : 'Envía una publicación nueva a uno de los grupos proveedor configurados.'}</p><button className="secondary-button" onClick={() => setTab(suppliers.length ? 'connection' : 'suppliers')}>{suppliers.length ? 'Revisar cuenta y grupos' : 'Configurar proveedor'}</button></div> : visibleProducts.length === 0 ? <div className="empty-state filtered-empty"><div className="empty-illustration">⌕</div><h3>No hay productos con estos filtros</h3><p>Prueba con otra búsqueda o cambia el estado seleccionado.</p><button className="secondary-button" onClick={() => { setSearch(''); setStatusFilter('all'); }}>Limpiar filtros</button></div> : <div className="product-list">{visibleProducts.map((product) => <ProductCard key={product.id} product={product} busy={busy || deletingProducts || sendingBatch} realSendsEnabled={distribution.realSendsEnabled} connected={distribution.connected} targetGroups={targetGroups} selectedImageIds={selectedImageIds} deleting={deletingProducts} onSelectImages={selectImages} onSend={() => sendProduct(product)} onDeleteImages={(ids) => void deleteSelectedPhotos(ids)} onApproved={refresh} onError={setMessage} onDraftChange={trackDraft} />)}</div>}
        </section>
      </> : tab === 'activity' ? <ActivityView logs={logs} sessionName={activeSession?.name ?? 'Cuenta'} onRefresh={() => refresh().catch((error) => setMessage(error.message))} /> : tab === 'connection' ? <WhatsAppView session={whatsApp} groups={groups} supplierSourceIds={suppliers.map((supplier) => supplier.sourceGroupId)} busy={busy || deletingProducts} onConnect={() => action(() => api(`/sessions/${sessionId}/connect`, { method: 'POST' }), 'Solicitud de conexión iniciada. Escanea el QR desde WhatsApp.')} onDisconnect={() => action(() => api(`/sessions/${sessionId}/disconnect`, { method: 'POST' }), 'Sesión desconectada.')} onReset={() => { if (window.confirm(`Se restablecerán únicamente las credenciales de ${activeSession?.name ?? 'esta cuenta'}. ¿Continuar?`)) void action(() => api(`/sessions/${sessionId}/reset-pairing`, { method: 'POST' }), 'Vinculación reiniciada. Espera el QR.'); }} onRefresh={() => refreshGroups().catch((error) => setMessage(error.message))} onSaveTargets={(targetGroupIds) => action(() => api(`/sessions/${sessionId}/targets`, { method: 'PUT', ...json({ targetGroupIds }) }), 'Destinos guardados para esta cuenta.')} onSaveSendInterval={(sendIntervalMs) => action(() => api(`/sessions/${sessionId}/send-interval`, { method: 'PUT', ...json({ sendIntervalMs }) }), 'Pausa entre envíos actualizada.')} onRecoverHistory={() => action(() => api(`/sessions/${sessionId}/recover-history`, { method: 'POST' }), 'Solicitud de historial iniciada. Mantén WhatsApp del teléfono conectado a Internet; los mensajes nuevos siguen entrando.')} onSaveReceptionSchedule={(schedule) => action(() => api(`/sessions/${sessionId}/reception-schedule`, { method: 'PUT', ...json(schedule) }), whatsApp?.status === 'connected' ? 'Rango guardado y recuperación solicitada. La recepción en vivo continúa.' : 'Rango guardado. Se solicitará el historial al conectar WhatsApp.')} onRename={(name) => action(() => api(`/sessions/${sessionId}`, { method: 'PATCH', ...json({ name }) }), 'Cuenta actualizada.')} /> : tab === 'suppliers' ? <SuppliersView sessionId={sessionId} groups={groups} suppliers={suppliers} defaultMargin={settings.marginCop} busy={busy || deletingProducts} onSave={saveSupplier} onDelete={(id) => { if (window.confirm('¿Archivar este proveedor? Las referencias ya recibidas se conservarán.')) void action(() => api(`/providers/${id}`, { method: 'DELETE' }), 'Proveedor archivado.'); }} /> : <SettingsView realSendsEnabled={distribution.realSendsEnabled} />}
      {approvalProducts && <BulkApprovalDialog products={approvalProducts} busy={busy || deletingProducts} onClose={() => setApprovalProducts(null)} onApprove={approveAll} />}
      <footer className="footer"><span>MINCHO SPORT <span className="footer-dot">·</span> Mundo de las Zapatillas</span><span>Los precios ambiguos y los resultados inciertos requieren revisión.</span></footer>
    </main>
  </div>;
}

type BulkApprovalItem = { id: string; sourcePricesCop?: number[]; outputText?: string; reviewMode: MarkMode };

function BulkApprovalDialog({ products, busy, onClose, onApprove }: { products: Product[]; busy: boolean; onClose: () => void; onApprove: (items: BulkApprovalItem[]) => Promise<void> }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [amounts, setAmounts] = useState<Record<string, string[]>>(() => Object.fromEntries(products.map((product) => [product.id, product.analysis.candidates.length ? product.analysis.candidates.map((candidate) => String(candidate.amountCop)) : ['']])));
  const [modes, setModes] = useState<Record<string, MarkMode>>(() => Object.fromEntries(products.map((product) => [product.id, product.shoe_code ? 'mark_all' : 'mark_world'])));
  const [error, setError] = useState('');
  useEffect(() => { dialogRef.current?.showModal(); }, []);
  function preparedText(product: Product): string {
    if (product.status !== 'needs_review') return prepareOutgoingDescription(product.output_text ?? '');
    const sourcePrices = (amounts[product.id] ?? []).map(Number);
    if (sourcePrices.some((value) => !Number.isSafeInteger(value) || value <= 0 || value > 1_000_000)) return '';
    const finals = sourcePrices.map((value, index) => addMargin(value, product.analysis.candidates[index]?.kind === 'box' ? product.box_margin_cop_applied ?? 0 : product.margin_cop_applied ?? 0));
    return prepareOutgoingDescription(product.analysis.candidates.length ? replacePriceCandidates(product.raw_text, product.analysis.candidates, finals) : `${product.raw_text}\nPRECIO ${formatCop(finals[0]!)}`);
  }
  const incomplete = products.some((product) => !product.images.length || product.margin_cop_applied === null || product.analysis.candidates.some((candidate) => candidate.kind === 'box') && product.box_margin_cop_applied === null || product.status === 'needs_review' && !preparedText(product));
  async function confirm() {
    setError('');
    try {
      await onApprove(products.map((product) => ({ id: product.id, reviewMode: modes[product.id]!, ...(product.status === 'needs_review' ? { sourcePricesCop: amounts[product.id]!.map(Number), outputText: preparedText(product) } : {}) })));
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo aprobar el lote.'); }
  }
  return <dialog ref={dialogRef} className="bulk-approval-dialog" aria-labelledby="bulk-approval-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id="bulk-approval-title">Aprobar TODO · {products.length} productos</h2>
    <p>Incluye precios ambiguos y fotografías en revisión de la cuenta y el proveedor seleccionados, aunque estén ocultos por la búsqueda o el filtro de estado. Confirma los importes y el marcado. Este botón aprueba; el envío se realiza después.</p>
    <p>Las fotos que ya están listas conservan su decisión. Las fotos pendientes o dudosas usarán la opción que elijas aquí. Los productos que ya participan en un envío quedan fuera del lote.</p>
    <div className="bulk-approval-list">{products.map((product) => {
      const unresolved = product.images.filter((image) => image.marking.status !== 'ready').length;
      return <section className="bulk-approval-item" key={product.id}><h3>{product.title || 'Sin nombre'} <small>{product.shoe_code ? `Código ${product.shoe_code}` : 'Sin código'}</small></h3>
        {product.images[0] && <img src={product.images[0].url} alt={`Original de ${product.title}`} />}
        {product.status === 'needs_review' && <div className="bulk-approval-prices">{amounts[product.id]!.map((value, index) => <label className="field-label" key={index}>{product.analysis.candidates[index]?.kind === 'box' ? 'CAJA' : 'PRECIO'} del proveedor (COP)<input className="text-input" type="number" min="1" max="1000000" step="1" value={value} disabled={busy} onChange={(event) => setAmounts((current) => ({ ...current, [product.id]: current[product.id]!.map((amount, amountIndex) => amountIndex === index ? event.target.value : amount) }))} /><span>Margen: {formatCop((product.analysis.candidates[index]?.kind === 'box' ? product.box_margin_cop_applied : product.margin_cop_applied) ?? 0)}</span></label>)}</div>}
        {!product.images.length && <p className="candidate-warning">Falta una fotografía original.</p>}
        {(product.margin_cop_applied === null || product.analysis.candidates.some((candidate) => candidate.kind === 'box') && product.box_margin_cop_applied === null) && <p className="candidate-warning">Falta configurar el margen del proveedor. Cierra este cuadro y configura sus reglas antes de aprobar.</p>}
        {unresolved > 0 && <label className="field-label">Decisión manual para {unresolved} foto(s) pendientes o en revisión<select className="group-select" value={modes[product.id]} disabled={busy} onChange={(event) => setModes((current) => ({ ...current, [product.id]: event.target.value as MarkMode }))}><option value="original">Conservar original</option><option value="mark_code" disabled={!product.shoe_code}>Agregar solo código</option><option value="mark_world">Agregar solo mundo</option><option value="mark_all" disabled={!product.shoe_code}>Agregar ambos</option></select></label>}
        <label className="field-label">Descripción que se aprobará</label><pre className="source-preview">{preparedText(product) || 'Completa el precio del proveedor para preparar la descripción.'}</pre>
      </section>;
    })}</div>
    {error && <p className="candidate-warning" role="alert">{error}</p>}
    {incomplete && <p className="candidate-warning">Completa los precios, las fotos o los márgenes indicados antes de aprobar todo.</p>}
    <div className="bulk-approval-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>Cancelar</button><button className="primary-button" disabled={busy || incomplete} onClick={() => void confirm()}>{busy ? 'Aprobando…' : `Aprobar los ${products.length} productos, incluidos los que están en revisión`}</button></div>
  </dialog>;
}

function Stat({ label, value, detail, symbol, accent = false }: { label: string; value: number; detail: string; symbol: string; accent?: boolean }) {
  return <article className="stat-card"><span className={`stat-symbol ${accent ? 'warm' : ''}`}>{symbol}</span><span className="stat-label">{label}</span><strong>{value.toString().padStart(2, '0')}</strong><span className="stat-detail">{detail}</span></article>;
}

function WhatsAppView({ session, groups, supplierSourceIds, busy, onConnect, onDisconnect, onReset, onRefresh, onSaveTargets, onSaveSendInterval, onSaveReceptionSchedule, onRecoverHistory, onRename }: { session: Session | null; groups: WhatsAppGroup[]; supplierSourceIds: string[]; busy: boolean; onConnect: () => void; onDisconnect: () => void; onReset: () => void; onRefresh: () => void; onSaveTargets: (targets: string[]) => Promise<void>; onSaveSendInterval: (intervalMs: number) => Promise<void>; onSaveReceptionSchedule: (schedule: Pick<ReceptionSchedule, 'startTime'|'endTime'>) => Promise<void>; onRecoverHistory: () => Promise<void>; onRename: (name: string) => Promise<void> }) {
  const [targets, setTargets] = useState<string[]>(session?.targetGroupIds ?? []);
  const [name, setName] = useState(session?.name ?? '');
  const [sendIntervalMs, setSendIntervalMs] = useState(session?.sendIntervalMs ?? 10000);
  const [receptionStartTime, setReceptionStartTime] = useState(session?.receptionSchedule.startTime ?? '16:00');
  const [receptionEndTime, setReceptionEndTime] = useState(session?.receptionSchedule.endTime ?? '19:00');
  useEffect(() => { setTargets(session?.targetGroupIds ?? []); setName(session?.name ?? ''); setSendIntervalMs(session?.sendIntervalMs ?? 10000); setReceptionStartTime(session?.receptionSchedule.startTime ?? '16:00'); setReceptionEndTime(session?.receptionSchedule.endTime ?? '19:00'); }, [session?.id, session?.targetGroupIds.join('|'), session?.name, session?.sendIntervalMs, session?.receptionSchedule.startTime, session?.receptionSchedule.endTime]);
  const connected = session?.status === 'connected';
  const statusLabel: Record<Session['status'], string> = { disabled: 'Deshabilitado', disconnected: 'Desconectado', connecting: 'Conectando', qr: 'Esperando escaneo del QR', connected: 'Conectado', logged_out: 'Sesión cerrada desde WhatsApp' };
  const toggle = (id: string) => setTargets((old) => old.includes(id) ? old.filter((item) => item !== id) : old.length < 5 ? [...old, id] : old);
  return <section className="wa-layout">
    <article className="panel settings-card wa-session-card"><div className="panel-title-row"><div><span className="panel-kicker">SESIÓN INDEPENDIENTE</span><h2>Baileys · WhatsApp Web</h2></div><span className={`wa-status ${connected ? 'online' : ''}`}><i />{statusLabel[session?.status ?? 'disconnected']}</span></div>
      <label className="field-label" htmlFor="account-name">Nombre de la cuenta</label><div className="inline-fields"><input id="account-name" className="text-input" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /><button className="secondary-button" disabled={busy || name.trim() === session?.name} onClick={() => void onRename(name)}>Guardar nombre</button></div>
      <p className="panel-copy">Las credenciales, grupos, proveedores y publicaciones quedan asociadas a esta cuenta. No se guarda el QR en el historial.</p>
      <div className="reception-window"><span className="panel-kicker">RANGO PARA RECUPERAR PUBLICACIONES DE HOY</span><div className="reception-time-fields"><label className="field-label" htmlFor="reception-start">Desde<input id="reception-start" type="time" className="text-input" value={receptionStartTime} onChange={(event) => setReceptionStartTime(event.target.value)} /></label><label className="field-label" htmlFor="reception-end">Hasta<input id="reception-end" type="time" className="text-input" value={receptionEndTime} onChange={(event) => setReceptionEndTime(event.target.value)} /></label></div><small>Hora de Colombia. Al conectar, solo se recuperan publicaciones del día en curso, desde la hora inicial hasta antes de la hora final, según su hora original de envío. Al guardar el rango con WhatsApp conectado se solicita su historial; también puedes pulsar Recuperar historial para reintentar. Mantén WhatsApp del teléfono conectado a Internet. Los mensajes nuevos se reciben a cualquier hora mientras la aplicación y WhatsApp estén conectados. La recuperación depende del historial que WhatsApp entregue.</small><button className="secondary-button" disabled={busy || receptionStartTime === receptionEndTime || (receptionStartTime === session?.receptionSchedule.startTime && receptionEndTime === session?.receptionSchedule.endTime)} onClick={() => void onSaveReceptionSchedule({ startTime: receptionStartTime, endTime: receptionEndTime })}>{connected ? 'Guardar y recuperar' : 'Guardar rango de recuperación'}</button><button className="secondary-button" disabled={busy || !connected || receptionStartTime !== session?.receptionSchedule.startTime || receptionEndTime !== session?.receptionSchedule.endTime} onClick={() => void onRecoverHistory()}>Recuperar historial</button></div>
      <label className="field-label spaced" htmlFor="send-interval">Pausa mínima entre fotos enviadas <span>por cuenta</span></label><select id="send-interval" className="group-select send-interval-select" value={sendIntervalMs} disabled={busy} onChange={(event) => { const value = Number(event.target.value); setSendIntervalMs(value); void onSaveSendInterval(value); }}>{[5000, 10000, 15000, 30000, 60000, 120000].map((value) => <option key={value} value={value}>{value / 1000} segundos</option>)}</select><small className="send-interval-note">Se aplica a cada imagen entre todos los destinos. Valor inicial: 10 segundos; mínimo permitido: 5 segundos.</small>
      {session?.qrDataUrl ? <div className="qr-box"><img src={session.qrDataUrl} alt="Código QR temporal para vincular WhatsApp" /><strong>Escanea desde WhatsApp → Dispositivos vinculados</strong><small>Si vence, pulsa conectar para solicitar un QR nuevo.</small></div> : <div className="wa-placeholder"><span>{connected ? '✓' : '◉'}</span><strong>{connected ? 'Sesión activa' : session?.status === 'disabled' ? 'Integración deshabilitada' : 'Vincula tu cuenta'}</strong><small>{session?.status === 'disabled' ? 'Activa APP_MODE=experimental y WHATSAPP_ENABLED=true en .env.' : connected ? 'Consulta y guarda los grupos de esta cuenta.' : 'Pulsa conectar y escanea el código con tu teléfono.'}</small></div>}
      {session?.lastError && <p className="wa-error">{session.lastError === 'rate-overlimit' ? 'WhatsApp limitó temporalmente la consulta de grupos. La aplicación hará una pausa antes de volver a consultarlos.' : session.lastError}</p>}
      {session?.reception && <div className="reception-diagnostics" aria-live="polite"><span className="panel-kicker">DIAGNÓSTICO DE RECEPCIÓN</span>
        {!session.reception.lastUpsertAt ? <p>Esta conexión aún no ha recibido eventos de mensajes. Verifica que este número esté vinculado al WhatsApp que participa en el grupo proveedor.</p> : session.reception.lastSupplierMessageAt ? <p>Último mensaje del proveedor <strong>{session.reception.lastSupplierName}</strong> · {timeLabel(session.reception.lastSupplierMessageAt)}. <b>{({ processing: 'procesando', stored: 'guardado en el catálogo', pending: 'pendiente de procesar', duplicate: 'ya estaba procesado', older_message_skipped: 'omitido por tener más de 24 horas o una fecha inválida', outside_recovery_window: 'omitido por estar fuera del día o rango de recuperación', unsupported_message: 'sin texto o foto compatible', error: 'falló la descarga o el guardado' } as Record<NonNullable<ReceptionDiagnostics['lastSupplierResult']>, string>)[session.reception.lastSupplierResult ?? 'processing']}</b></p> : session.reception.lastGroupMessageAt ? <p>WhatsApp reportó actividad en <strong>{session.reception.lastGroupName}</strong>, pero no en un grupo proveedor configurado.</p> : <p>WhatsApp recibió eventos ({session.reception.lastUpsertType}, {session.reception.lastUpsertMessageCount} mensaje(s)), pero no reportó mensajes de grupos proveedor.</p>}
        <small>{session.reception.lastUpsertAt ? `Último evento: ${timeLabel(session.reception.lastUpsertAt)} · ${session.reception.lastUpsertType}.` : 'El diagnóstico empieza al conectar y se reinicia cuando se reinicia el servidor.'}</small>
      </div>}
      {session?.receptionQueue && <div className="reception-history" aria-live="polite"><span className="panel-kicker">RECUPERACIÓN DE HOY · {session.receptionSchedule.startTime}–{session.receptionSchedule.endTime}</span><p>{session.receptionQueue.recoveryStatus === 'waiting' ? 'Esperando publicaciones del rango guardado que WhatsApp pueda entregar…' : session.receptionQueue.recoveryStatus === 'received' ? `Baileys entregó ${session.receptionQueue.recoveryMessageCount} mensaje(s) de grupos proveedor dentro del rango guardado.` : session.receptionQueue.recoveryStatus === 'unavailable' ? 'No se recibieron mensajes nuevos de historial en el último intento. Las publicaciones ya recuperadas permanecen en el catálogo.' : 'La aplicación intentará recuperar mensajes al conectar la cuenta.'}</p>{session.receptionQueue.recoveryWarning && <small>{session.receptionQueue.recoveryWarning}</small>}<div className="reception-counters"><span><strong>{session.receptionQueue.recoveryRequestedGroups}</strong> grupos con historial solicitado</span><span><strong>{session.receptionQueue.recoveryMissingAnchors}</strong> sin referencia para solicitar</span><span><strong>{session.receptionQueue.recoveryFailedRequests}</strong> solicitudes fallidas</span><span><strong>{session.receptionQueue.pendingCount}</strong> pendientes de procesar</span><span><strong>{session.receptionQueue.failedCount}</strong> con error</span></div>{session.receptionQueue.recoveryFinishedAt && <small>Último intento: {timeLabel(session.receptionQueue.recoveryFinishedAt)}</small>}</div>}
      <div className="wa-actions"><button className="primary-button" disabled={busy || !session?.enabled || connected || session?.status === 'connecting' || session?.status === 'qr'} onClick={onConnect}>Conectar con QR <span>→</span></button><button className="secondary-button" disabled={busy || !connected} onClick={onDisconnect}>Desconectar</button>{session?.enabled && !['connected','connecting','qr'].includes(session.status) && <button className="secondary-button" disabled={busy} onClick={onReset}>Restablecer y generar QR</button>}</div>
      <div className="wa-risk"><strong>Riesgo de cuenta.</strong> Baileys no es una API oficial; WhatsApp puede cambiar el protocolo o restringir cuentas. Prueba solo con grupos propios o autorizados y evita envíos masivos no solicitados.</div>
    </article>
    <article className="panel settings-card wa-groups-card"><div className="panel-title-row"><div><span className="panel-kicker">GRUPOS DE ESTA CUENTA</span><h2>Grupos destino compartidos</h2></div><button className="icon-button" onClick={onRefresh} disabled={!connected} title="Actualizar grupos">↻</button></div><p className="panel-copy">Los destinos se comparten entre los proveedores de esta cuenta. No pueden ser simultáneamente un proveedor.</p>
      <div className="wa-target-heading"><strong>Destinos seleccionados</strong><span>{targets.length} / 5</span></div>
      {groups.length === 0 ? <div className="group-empty">Conecta la cuenta y actualiza la lista de grupos.</div> : <div className="wa-group-list">{groups.filter((group) => !supplierSourceIds.includes(group.id)).map((group) => <label key={group.id} className="wa-group-option"><input type="checkbox" checked={targets.includes(group.id)} disabled={!connected || (!targets.includes(group.id) && targets.length >= 5)} onChange={() => toggle(group.id)} /><span><strong>{group.name}</strong><small>{group.id}</small></span></label>)}</div>}
      <div className="settings-actions"><button className="primary-button" disabled={busy || !connected} onClick={() => void onSaveTargets(targets)}>Guardar destinos <span>→</span></button></div>
    </article>
  </section>;
}

function SuppliersView({ sessionId, groups, suppliers, defaultMargin, busy, onSave, onDelete }: { sessionId: string; groups: WhatsAppGroup[]; suppliers: Supplier[]; defaultMargin: number; busy: boolean; onSave: (supplier: Omit<Supplier, 'id'|'sessionId'|'sourceGroupName'>, id?: string) => Promise<boolean>; onDelete: (id: string) => void }) {
  const emptyForm = (): Omit<Supplier, 'id'|'sessionId'|'sourceGroupName'> => ({ name: '', sourceGroupId: '', priceMarginCop: defaultMargin, boxMarginCop: 5000, markerText: '🌎⭐', defaultPosition: 'bottom_right' });
  const [editingId, setEditingId] = useState<string | undefined>();
  const [form, setForm] = useState(emptyForm);
  useEffect(() => { setEditingId(undefined); setForm(emptyForm()); }, [sessionId, defaultMargin]);
  const availableGroups = groups.filter((group) => !suppliers.some((supplier) => supplier.sourceGroupId === group.id && supplier.id !== editingId));
  const formIssue = !form.name.trim() ? 'Escribe el nombre del proveedor o selecciona su grupo para usar el nombre del grupo.'
    : !form.sourceGroupId ? 'Selecciona el grupo del proveedor.'
    : !availableGroups.some((group) => group.id === form.sourceGroupId) ? 'Selecciona un grupo disponible; el anterior ya tiene un proveedor.'
    : !Number.isSafeInteger(form.priceMarginCop) || form.priceMarginCop < 0 || form.priceMarginCop > 1000000 ? 'El margen de PRECIO debe ser un valor entero entre $0 y $1.000.000.'
    : !Number.isSafeInteger(form.boxMarginCop) || form.boxMarginCop < 0 || form.boxMarginCop > 1000000 ? 'El margen de CAJA debe ser un valor entero entre $0 y $1.000.000.' : '';
  function edit(supplier: Supplier) { setEditingId(supplier.id); setForm({ name: supplier.name, sourceGroupId: supplier.sourceGroupId, priceMarginCop: supplier.priceMarginCop, boxMarginCop: supplier.boxMarginCop, markerText: supplier.markerText, defaultPosition: supplier.defaultPosition }); }
  function update<K extends keyof typeof form>(key: K, value: typeof form[K]) { setForm((current) => ({ ...current, [key]: value })); }
  return <section className="settings-layout suppliers-layout">
    <article className="panel settings-card"><div className="panel-title-row"><div><span className="panel-kicker">PERFIL DE PROVEEDOR</span><h2>{editingId ? 'Editar reglas' : 'Agregar proveedor'}</h2></div><span className="settings-icon">◇</span></div>
      <p className="panel-copy">Configura por separado la ganancia de PRECIO y CAJA. Usa $0 cuando esa bodega ya incluya tu ganancia. Las reglas se copian a productos nuevos.</p>
      <label className="field-label" htmlFor="supplier-name">Nombre para identificarlo</label><input id="supplier-name" className="text-input" value={form.name} maxLength={100} onChange={(event) => update('name', event.target.value)} placeholder="Ej. Bodega Centro" />
      <label className="field-label spaced" htmlFor="supplier-source">Grupo proveedor de esta cuenta</label><select id="supplier-source" className="group-select" value={form.sourceGroupId} onChange={(event) => { const sourceGroupId = event.target.value; setForm((current) => ({ ...current, sourceGroupId, name: current.name.trim() ? current.name : (groups.find((group) => group.id === sourceGroupId)?.name ?? '').slice(0, 100) })); }}><option value="">Selecciona un grupo…</option>{availableGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select>
      {(['priceMarginCop', 'boxMarginCop'] as const).map((key) => { const label = key === 'priceMarginCop' ? 'Margen sobre PRECIO' : 'Margen sobre CAJA'; return <div key={key}><label className="field-label spaced" htmlFor={`supplier-${key}`}>{label} <span>COP</span></label><div className="money-input"><span>$</span><input id={`supplier-${key}`} type="number" min="0" max="1000000" step="1000" value={form[key]} onChange={(event) => update(key, Number(event.target.value))} /></div><div className="margin-options compact">{[0, 5000, 10000].map((amount) => <button type="button" key={amount} className={form[key] === amount ? 'margin-option selected' : 'margin-option'} onClick={() => update(key, amount)}><strong>{formatCop(amount)}</strong></button>)}</div></div>; })}
      <label className="field-label spaced" htmlFor="supplier-marker">Marca sobre la foto</label><div className="marker-presets">{['🌎⭐','🌎','🌎.','- 🌎⭐','🌍⭐','🌏⭐','🌐⭐'].map((marker) => <button type="button" key={marker} className={form.markerText === marker ? 'marker-preset selected' : 'marker-preset'} onClick={() => update('markerText', marker)}>{marker}</button>)}</div><div className="marker-custom"><input id="supplier-marker" aria-label="Marca personalizada" className="text-input" maxLength={32} value={form.markerText} onChange={(event) => update('markerText', event.target.value)} /><small>Debe incluir un emoji de mundo. Se admite punto, guion y estrella.</small></div>
      <label className="field-label spaced" htmlFor="supplier-position">Esquina predeterminada</label><select id="supplier-position" className="group-select" value={form.defaultPosition} onChange={(event) => update('defaultPosition', event.target.value as OverlayPosition)}>{POSITIONS.map((position) => <option key={position.id} value={position.id}>{position.label}</option>)}</select>
      {(busy || formIssue) && <p id="supplier-form-status" className="panel-copy" role="status">{busy ? 'Guardando cambios…' : formIssue}</p>}
      <div className="settings-actions"><button className="primary-button" aria-describedby={busy || formIssue ? 'supplier-form-status' : undefined} disabled={busy || Boolean(formIssue)} onClick={async () => { if (await onSave(form, editingId)) { setEditingId(undefined); setForm(emptyForm()); } }}>{editingId ? 'Guardar reglas' : 'Agregar proveedor'} <span>→</span></button>{editingId && <button className="secondary-button" disabled={busy} onClick={() => { setEditingId(undefined); setForm(emptyForm()); }}>Cancelar</button>}</div>
    </article>
    <article className="panel settings-card"><div className="panel-title-row"><div><span className="panel-kicker">PROVEEDORES DE LA CUENTA</span><h2>Reglas activas <span className="count-badge">{suppliers.length}</span></h2></div></div>{suppliers.length === 0 ? <div className="group-empty">Aún no configuraste proveedores. Primero conecta la cuenta y actualiza sus grupos.</div> : <div className="supplier-list">{suppliers.map((supplier) => <article className="supplier-row" key={supplier.id}><div><strong>{supplier.name}</strong><span>{supplier.sourceGroupName ?? supplier.sourceGroupId}</span><small>Precio {formatCop(supplier.priceMarginCop)} · Caja {formatCop(supplier.boxMarginCop)} · {supplier.markerText} · {POSITIONS.find((item) => item.id === supplier.defaultPosition)?.label}</small></div><div className="supplier-actions"><button className="secondary-button" disabled={busy} onClick={() => edit(supplier)}>Editar</button><button className="secondary-button" disabled={busy} onClick={() => onDelete(supplier.id)}>Archivar</button></div></article>)}</div>}</article>
  </section>;
}

function ProductCard({ product, busy, realSendsEnabled, connected, targetGroups, selectedImageIds, deleting, onSelectImages, onSend, onDeleteImages, onApproved, onError, onDraftChange }: { product: Product; busy: boolean; realSendsEnabled: boolean; connected: boolean; targetGroups: WhatsAppGroup[]; selectedImageIds: string[]; deleting: boolean; onSelectImages: (ids: string[], selected: boolean) => void; onSend: () => void; onDeleteImages: (ids: string[]) => void; onApproved: () => Promise<void>; onError: (value: string) => void; onDraftChange: (id: string, dirty: boolean) => void }) {
  const imageIds = product.images.map((image) => image.id);
  const selected = imageIds.length > 0 && imageIds.every((id) => selectedImageIds.includes(id));
  const partiallySelected = !selected && imageIds.some((id) => selectedImageIds.includes(id));
  const margin = product.margin_cop_applied ?? 0;
  const boxMargin = product.box_margin_cop_applied ?? 0;
  const candidates = product.analysis.candidates;
  const candidate = product.analysis.candidates.length === 1 ? product.analysis.candidates[0] : undefined;
  const [price, setPrice] = useState(candidate?.amountCop ? String(candidate.amountCop) : '');
  const [sourcePrices, setSourcePrices] = useState(() => candidates.map((item) => String(item.amountCop)));
  const [output, setOutput] = useState(product.output_text ? prepareOutgoingDescription(product.output_text) : prepareOutgoingDescription(candidates.length ? replacePriceCandidates(product.raw_text, candidates, candidates.map((item) => addMargin(item.amountCop, item.kind === 'box' ? boxMargin : margin))) : product.raw_text));
  const [expanded, setExpanded] = useState(product.status === 'needs_review');
  const [shoeCode, setShoeCode] = useState(product.shoe_code ?? '');
  const [position, setPosition] = useState<OverlayPosition>(product.image_position ?? 'bottom_right');
  const [previewVersion, setPreviewVersion] = useState(0);
  const [savingImage, setSavingImage] = useState(false);
  const [inspectingImage, setInspectingImage] = useState(false);
  const [approving, setApproving] = useState(false);
  const [savingDescription, setSavingDescription] = useState(false);
  const [codeRequest, setCodeRequest] = useState<{ assetId: string; mode: 'mark_code' | 'mark_all' } | null>(null);
  const [lightbox, setLightbox] = useState<{ url: string; label: string } | null>(null);
  const lightboxRef = useRef<HTMLDialogElement>(null);
  const captionCode = extractShoeCode(product.raw_text).code;
  const publications = product.publications.map((publication) => publication.status);
  const sendUncertain = publications.includes('needs_review');
  const isSending = publications.includes('in_progress');
  const isQueued = publications.includes('queued');
  const isSent = publications.includes('submitted');
  const pendingTargets = pendingTargetIds(product, targetGroups.map((group) => group.id));
  const isPartial = isSent && pendingTargets.length > 0;
  const targetCount = pendingTargets.length;
  const statusLabel = sendUncertain ? 'Conciliar envío' : isSending ? 'Enviando' : isQueued ? 'En cola' : product.status === 'needs_review' || product.images.some((image) => image.marking.status === 'review') ? 'Por revisar' : isPartial ? 'Destinos pendientes' : isSent ? 'Enviado' : 'Preparado';
  const statusClass = sendUncertain ? 'needs_review' : isSending ? 'in_progress' : isQueued ? 'queued' : product.status === 'needs_review' || product.images.some((image) => image.marking.status === 'review') ? 'needs_review' : isSent ? 'submitted' : 'approved';
  useEffect(() => {
    if (product.status === 'needs_review') {
      const found = product.analysis.candidates.length === 1 ? product.analysis.candidates[0] : undefined;
      setSourcePrices(product.analysis.candidates.map((item) => String(item.amountCop)));
      setPrice(found ? String(found.amountCop) : '');
      setOutput(prepareOutgoingDescription(product.analysis.candidates.length ? replacePriceCandidates(product.raw_text, product.analysis.candidates, product.analysis.candidates.map((item) => addMargin(item.amountCop, item.kind === 'box' ? boxMargin : margin))) : product.raw_text));
    } else {
      setOutput(prepareOutgoingDescription(product.output_text ?? ''));
      if (!product.analysis.candidates.length) setPrice(product.source_price_cop === null ? '' : String(product.source_price_cop));
    }
  }, [product.id, product.status, product.output_text]);
  useEffect(() => { setShoeCode(product.shoe_code ?? ''); setPosition(product.image_position ?? 'bottom_right'); }, [product.id, product.shoe_code, product.image_position]);
  useEffect(() => {
    const dialog = lightboxRef.current;
    if (!dialog) return;
    if (lightbox && !dialog.open) dialog.showModal();
    else if (!lightbox && dialog.open) dialog.close();
  }, [lightbox]);
  const sourcePrice = Number(price);
  const finalPrice = Number.isSafeInteger(sourcePrice) && sourcePrice > 0 && sourcePrice <= 1_000_000 ? addMargin(sourcePrice, margin) : null;
  const numericSourcePrices = sourcePrices.map((value) => Number(value));
  const finalPrices = numericSourcePrices.length === candidates.length && numericSourcePrices.every((value) => Number.isSafeInteger(value) && value > 0 && value <= 1_000_000)
    ? numericSourcePrices.map((value, index) => addMargin(value, candidates[index]?.kind === 'box' ? boxMargin : margin)) : null;
  const canEdit = !product.publications.some((publication) => ['submitted', 'queued', 'in_progress', 'needs_review'].includes(publication.status));
  const canSend = hasPendingDistribution(product, targetGroups.map((group) => group.id));
  const reviewDefault = prepareOutgoingDescription(candidates.length ? replacePriceCandidates(product.raw_text, candidates, candidates.map((item) => addMargin(item.amountCop, item.kind === 'box' ? boxMargin : margin))) : product.raw_text);
  const reviewDirty = product.status === 'needs_review' && (output !== reviewDefault || sourcePrices.some((value, index) => value !== String(candidates[index]?.amountCop ?? '')) || (!candidates.length && price !== ''));
  const descriptionDirty = product.status !== 'needs_review' && output !== prepareOutgoingDescription(product.output_text ?? '');
  const imageOptionsDirty = shoeCode.trim() !== (product.shoe_code ?? '') || position !== (product.image_position ?? 'bottom_right');
  const editing = approving || savingDescription || savingImage || inspectingImage;
  useEffect(() => { onDraftChange(product.id, descriptionDirty || reviewDirty || imageOptionsDirty || editing); }, [product.id, descriptionDirty, reviewDirty, imageOptionsDirty, editing, onDraftChange]);
  useEffect(() => () => onDraftChange(product.id, false), [product.id, onDraftChange]);
  const markingReady = product.images.length > 0 && product.images.every((image) => image.marking.status === 'ready');
  const sendBlockReason = descriptionDirty || imageOptionsDirty ? 'Guarda los cambios de descripción y fotografía antes de enviar.' : !realSendsEnabled ? 'El envío real está deshabilitado. Actívalo en Configuración.' : !connected ? 'Conecta esta cuenta de WhatsApp para enviar.' : targetCount === 0 ? 'Selecciona grupos destino en Cuentas y conexión.' : !markingReady ? 'Espera el análisis de las fotos o resuelve las que requieren revisión.' : product.margin_cop_applied === null ? 'Configura el margen del proveedor antes de enviar.' : candidates.some((item) => item.kind === 'box') && product.box_margin_cop_applied === null ? 'Configura el margen de CAJA de este proveedor.' : null;
  function updateSourcePrice(value: string) {
    setPrice(value);
  }
  function updateCandidatePrice(index: number, value: string) {
    const next = sourcePrices.map((current, currentIndex) => currentIndex === index ? value : current);
    setSourcePrices(next);
    const amounts = next.map(Number);
    if (amounts.every((amount) => Number.isSafeInteger(amount) && amount > 0 && amount <= 1_000_000)) {
      setOutput(prepareOutgoingDescription(replacePriceCandidates(product.raw_text, candidates, amounts.map((amount, currentIndex) => addMargin(amount, candidates[currentIndex]?.kind === 'box' ? boxMargin : margin)))));
    }
  }
  async function approve() {
    setApproving(true);
    try { const result = await api<{ outputText: string }>(`/products/${product.id}/approve`, { method: 'POST', ...json({ ...(candidates.length ? { sourcePricesCop: numericSourcePrices } : { sourcePriceCop: sourcePrice }), outputText: output }) }); setOutput(result.outputText); await onApproved(); onError('Precio y texto aprobados. La descripción quedó con los márgenes configurados.'); }
    catch (error) { onError(error instanceof Error ? error.message : 'No se pudo aprobar.'); }
    finally { setApproving(false); }
  }
  async function saveDescription() {
    setSavingDescription(true);
    try {
      const result = await api<{ outputText: string }>(`/products/${product.id}/description`, { method: 'PUT', ...json({ outputText: output }) });
      setOutput(result.outputText); await onApproved(); onError('Descripción guardada. Se conservaron los precios aprobados y se eliminó cualquier línea con docena.');
    } catch (error) { onError(error instanceof Error ? error.message : 'No se pudo guardar la descripción.'); }
    finally { setSavingDescription(false); }
  }
  async function saveImageOptions(nextCode = shoeCode) {
    setSavingImage(true);
    try { await api(`/products/${product.id}/image-options`, { method: 'PUT', ...json({ shoeCode: nextCode.trim() || null, position }) }); setShoeCode(nextCode); setPreviewVersion(Date.now()); await onApproved(); }
    catch (error) { onError(error instanceof Error ? error.message : 'No se pudo marcar la foto.'); }
    finally { setSavingImage(false); }
  }
  async function inspectImages() {
    setInspectingImage(true);
    try {
      const result = await api<{ inspections: Array<{ assetId: string; inspection: ImageInspection }>; errors: Array<{ message: string }> }>(`/products/${product.id}/inspect-image`, { method: 'POST' });
      setPreviewVersion(Date.now());
      await onApproved();
      if (result.errors.length) onError(`Se analizaron ${result.inspections.length} foto(s), pero una foto presentó un error: ${result.errors[0]?.message ?? 'Error local.'}`);
      else if (result.inspections.some((item) => item.inspection.ocrError)) onError('La búsqueda visual terminó; no se pudo iniciar el OCR. Revisa la conexión y el historial del servidor.');
      else onError('Análisis local completo. Revisa los códigos sugeridos y la detección del emoji antes de actualizar la vista previa.');
    } catch (error) { onError(error instanceof Error ? error.message : 'No se pudieron analizar las fotos localmente.'); }
    finally { setInspectingImage(false); }
  }
  async function resolveMarking(assetId: string, mode: MarkMode | 'automatic') {
    if ((mode === 'mark_code' || mode === 'mark_all') && !shoeCode.trim()) {
      setCodeRequest({ assetId, mode });
      return;
    }
    setSavingImage(true);
    try {
      if (imageOptionsDirty) await api(`/products/${product.id}/image-options`, { method: 'PUT', ...json({ shoeCode: shoeCode.trim() || null, position }) });
      await api(`/products/${product.id}/images/${assetId}/marking`, { method: 'PUT', ...json({ mode }) });
      setPreviewVersion(Date.now());
      await onApproved();
      setCodeRequest(null);
      onError('Decisión guardada para esta fotografía.');
    } catch (error) { onError(error instanceof Error ? error.message : 'No se pudo confirmar la fotografía.'); }
    finally { setSavingImage(false); }
  }
  return <article className="product-card">
    <div className="product-summary-row"><label className={`product-select ${imageIds.length ? '' : 'not-selectable'}`} title="Seleccionar las fotos de esta referencia"><input type="checkbox" aria-label={`Seleccionar fotos de ${product.title || 'producto'}`} checked={selected} ref={(input) => { if (input) input.indeterminate = partiallySelected; }} disabled={!imageIds.length || deleting} onChange={(event) => onSelectImages(imageIds, event.target.checked)} /><span /></label><button className="product-summary" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}><span className="product-thumb">{product.images[0] ? <img src={product.images[0].url} alt="" /> : <span>▱</span>}</span><span className="product-summary-main"><strong>{product.title || 'Sin nombre'}</strong><span>{product.supplier_name ?? 'Histórico sin proveedor'} <i>·</i> {product.images.length} {product.images.length === 1 ? 'fotografía' : 'fotografías'} <i>·</i> {timeLabel(product.created_at)}</span></span><span className={`status-tag ${statusClass}`}>{['needs_review','in_progress','queued'].includes(statusClass) && <i />}{statusLabel}</span><span className="summary-price">{product.final_price_cop !== null ? formatCop(product.final_price_cop) : '—'}</span><span className="expand-chevron">{expanded ? '⌃' : '⌄'}</span></button></div>
    {expanded && <div className="product-detail">
      <div className="product-provenance"><span><strong>Cuenta:</strong> {product.session_name}</span><span><strong>Proveedor:</strong> {product.supplier_name ?? 'No asignado'}</span><span><strong>Margen PRECIO:</strong> {product.margin_cop_applied === null ? 'Sin configurar' : formatCop(product.margin_cop_applied)}</span><span><strong>Margen CAJA:</strong> {product.box_margin_cop_applied === null ? 'Sin configurar' : formatCop(product.box_margin_cop_applied)}</span></div>
      {(product.publications.length > 0 || targetGroups.length > 0) && <div className="candidate-note"><strong>Distribución por grupo</strong><ul>{product.publications.map((publication, index) => <li key={`${publication.groupId}-${index}`}>{publication.groupName}: {publication.status === 'submitted' ? 'aceptado por Baileys; entrega no confirmada' : publication.status === 'queued' ? 'en cola' : publication.status === 'in_progress' ? 'enviando' : publication.status === 'needs_review' ? 'requiere conciliación' : publication.status}</li>)}{targetGroups.filter((group) => !product.publications.some((publication) => publication.groupId === group.id)).map((group) => <li key={group.id}>{group.name}: <strong>pendiente de enviar</strong></li>)}</ul>{isPartial && <span>El siguiente envío completará únicamente los destinos pendientes.</span>}</div>}
      <div className="review-columns"><div className="product-review-column"><label className="field-label">Fotografías · pulsa para ampliar</label><div className="product-mark-previews">{product.images.map((image, index) => { const previewUrl = `${product.markedImageUrl}?assetId=${encodeURIComponent(image.id)}&v=${previewVersion}&state=${encodeURIComponent([image.marking.status, image.marking.mode, image.marking.manual, image.inspection?.inspectedAt, product.shoe_code, product.updated_at].join(':'))}`; return <div className="image-comparison" key={image.id}><div className="photo-selection"><label><input type="checkbox" aria-label={`Seleccionar foto ${index + 1} de ${product.title || 'producto'}`} checked={selectedImageIds.includes(image.id)} disabled={deleting} onChange={(event) => onSelectImages([image.id], event.target.checked)} /> Foto {index + 1}</label><button type="button" className="secondary-button delete-product-button" aria-label={`Eliminar foto ${index + 1} de ${product.title || 'producto'}`} disabled={deleting} onClick={() => onDeleteImages([image.id])}>Eliminar esta foto</button></div><figure><button type="button" className="image-open" aria-label={`Ampliar fotografía original ${index + 1}`} onClick={() => setLightbox({ url: image.url, label: `Fotografía original ${index + 1}` })}><img src={image.url} alt={`Fotografía original ${index + 1}`} /></button><figcaption>Original {index + 1} · sin cambios</figcaption></figure><figure><button type="button" className="image-open" aria-label={`Ampliar vista previa ${index + 1}`} onClick={() => setLightbox({ url: previewUrl, label: `Resultado marcado, fotografía ${index + 1}` })}><img src={previewUrl} alt={`Vista previa marcada ${index + 1}`} /></button><figcaption>{image.marking.status === 'ready' ? image.marking.mode === 'original' ? `Se enviará original ${index + 1}` : `Se enviará marcada ${index + 1}` : `Vista original · ${image.marking.status === 'pending' ? 'analizando' : 'requiere revisión'}`}</figcaption></figure><div className={image.marking.status === 'review' ? 'candidate-warning image-marking-decision' : 'candidate-note image-marking-decision'}><strong>Foto {index + 1}: {image.marking.status === 'ready' ? 'lista' : image.marking.status === 'pending' ? 'analizando' : 'por revisar'}</strong><span>{image.marking.reason}</span><small>Si el análisis se equivoca, elige qué añadir sobre la foto original. Cada elección reemplaza la anterior.</small><div className="image-marking-actions" role="group" aria-label={`Marcado de fotografía ${index + 1}`}>{([['original', 'Conservar original'], ['mark_code', 'Agregar solo código'], ['mark_world', 'Agregar solo mundo'], ['mark_all', 'Agregar ambos'], ['automatic', 'Usar detección automática']] as const).map(([mode, label]) => <button key={mode} type="button" className="secondary-button" aria-pressed={mode === 'automatic' ? !image.marking.manual : image.marking.manual && image.marking.mode === mode} disabled={busy || editing || !canEdit} title={['mark_code', 'mark_all'].includes(mode) && !shoeCode.trim() ? 'Pulsa para introducir el código y agregarlo a la foto.' : undefined} onClick={() => void resolveMarking(image.id, mode)}>{label}</button>)}</div>{codeRequest?.assetId === image.id && <form className="marking-code-request" onSubmit={(event) => { event.preventDefault(); void resolveMarking(image.id, codeRequest.mode); }}><label className="field-label" htmlFor={`marking-code-${image.id}`}>Escribe el código que quieres agregar</label><input id={`marking-code-${image.id}`} className="text-input" autoFocus required maxLength={32} value={shoeCode} disabled={busy || editing || !canEdit} onChange={(event) => setShoeCode(event.target.value)} placeholder="1059" /><small>No se reconoció un código en la descripción. Puedes escribirlo aquí; se guardará junto con el marcado.</small><div className="image-marking-actions"><button className="primary-button" type="submit" disabled={busy || editing || !canEdit || !shoeCode.trim()}>{codeRequest.mode === 'mark_all' ? 'Guardar código y agregar ambos' : 'Guardar y agregar solo código'}</button><button className="secondary-button" type="button" disabled={editing} onClick={() => setCodeRequest(null)}>Cancelar</button></div></form>}</div></div>; })}</div>
        <label className="field-label spaced">Descripción recibida</label><pre className="source-preview">{product.raw_text || 'La descripción llegó en otro mensaje; revisa que corresponda a esta fotografía.'}</pre>{product.analysis.excluded.length > 0 && <div className="candidate-note">El sistema descartó estos números como precio: {product.analysis.excluded.map((entry) => `${entry.raw} (${entry.reason})`).join(' · ')}</div>}{candidates.length > 1 && (candidates.some((item) => item.kind === 'box') && candidates.some((item) => item.kind === 'price') ? <div className="candidate-note">Se detectaron PRECIO y CAJA; cada importe usa el margen correspondiente a su proveedor.</div> : <div className="candidate-warning">Se encontraron varios precios posibles. Confirma cada importe antes de aprobar.</div>)}
        {candidates.length ? <div className="detected-price-list">{candidates.map((item, index) => { const itemMargin = item.kind === 'box' ? boxMargin : margin; const itemFinal = finalPrices?.[index]; const itemLabel = item.kind === 'box' ? 'Precio de CAJA' : item.kind === 'price' ? 'Precio' : 'Importe por clasificar'; return <section className="detected-price-item" key={`${item.start}-${index}`}><label className="field-label" htmlFor={`price-${product.id}-${index}`}>{itemLabel} <span>COP</span></label><div className="money-input"><span>$</span><input id={`price-${product.id}-${index}`} type="number" min="1" step="1" value={sourcePrices[index] ?? ''} disabled={product.status !== 'needs_review'} onChange={(event) => updateCandidatePrice(index, event.target.value)} /></div><div className="price-equation"><span>Margen de {item.kind === 'box' ? 'CAJA' : 'PRECIO'}</span><strong>+ {formatCop(itemMargin)}</strong><span>Precio de venta</span><strong className="sale-price">{itemFinal !== undefined ? formatCop(itemFinal) : '—'}</strong></div></section>; })}</div> : <><label className="field-label spaced" htmlFor={`price-${product.id}`}>Precio del proveedor <span>COP</span></label><div className="money-input"><span>$</span><input id={`price-${product.id}`} type="number" min="1" step="1" value={price} disabled={product.status !== 'needs_review'} onChange={(event) => updateSourcePrice(event.target.value)} placeholder="60000" /></div><div className="price-equation"><span>Margen del proveedor</span><strong>+ {formatCop(margin)}</strong><span>Precio de venta</span><strong className="sale-price">{finalPrice !== null ? formatCop(finalPrice) : '—'}</strong></div></>}
        <label className="field-label spaced" htmlFor={`output-${product.id}`}>Texto y descripción que se enviarán</label><textarea id={`output-${product.id}`} className="output-edit" rows={7} value={output} maxLength={12000} disabled={busy || editing || !canEdit} onChange={(event) => setOutput(event.target.value)} />
        <p className="image-inspect-note">Puedes corregir el texto antes de enviarlo. Al guardar se eliminan todas las líneas con docena y se conserva el formato de publicación.</p>
        {product.status !== 'needs_review' && canEdit && <button className="secondary-button full-button" disabled={busy || editing || !descriptionDirty || !output.trim()} onClick={() => void saveDescription()}>{savingDescription ? 'Guardando…' : 'Guardar descripción'}</button>}
        {descriptionDirty && <div className="candidate-warning">Hay cambios en la descripción sin guardar.</div>}
        {product.status === 'needs_review' && <button className="primary-button full-button" disabled={busy || approving || (candidates.length ? finalPrices === null : !finalPrice) || product.margin_cop_applied === null || (candidates.some((item) => item.kind === 'box') && product.box_margin_cop_applied === null) || !product.images.length} onClick={() => void approve()}><span>{approving ? 'Aprobando…' : 'Aprobar precio y texto'}</span><span>{approving ? '…' : '→'}</span></button>}
        {['approved', 'simulated'].includes(product.status) && canSend && <><button className="primary-button full-button" disabled={busy || editing || Boolean(sendBlockReason) || product.margin_cop_applied === null || (candidates.some((item) => item.kind === 'box') && product.box_margin_cop_applied === null)} onClick={onSend}><span>{isPartial ? 'Completar envío a' : 'Enviar fotografía y descripción a'} {targetCount} {targetCount === 1 ? 'grupo' : 'grupos'}</span><span>↗</span></button>{sendBlockReason && <div className="send-block-reason" role="note">{sendBlockReason}</div>}</>}
        {isSending && <div className="send-inline-status" role="status"><span className="progress-pulse" /> Enviando a los grupos destino. Esta pantalla se actualizará al confirmar cada foto.</div>}
        {isQueued && <div className="send-inline-status" role="status"><span className="progress-pulse" /> En cola · se respetará la pausa configurada entre fotos.</div>}
        {isSent && <><div className="simulated-note"><span>✓</span> Baileys aceptó la publicación. WhatsApp no confirma aquí si los destinatarios la recibieron.</div></>}</div><div className="product-tools-column">
        <label className="field-label spaced" htmlFor={`code-${product.id}`}>Código para la fotografía <span>opcional</span></label><input id={`code-${product.id}`} className="text-input" value={shoeCode} disabled={busy || editing || !canEdit} maxLength={32} onChange={(event) => setShoeCode(event.target.value)} placeholder="143 o AB-123" /><p className="image-inspect-note">La etiqueta añade H para HOMBRE/CABALLERO o D para MUJER/DAMA, después del código y antes del mundo.</p>
        {captionCode && captionCode.toUpperCase() !== (product.shoe_code ?? '').toUpperCase() && <div className="candidate-note">Código detectado en la descripción: <strong>{captionCode}</strong> <button className="secondary-button" disabled={busy || savingImage} onClick={() => void saveImageOptions(captionCode)}>Usar código de la descripción</button></div>}
        <button className="secondary-button image-inspect-button" disabled={inspectingImage || busy || product.images.length === 0} onClick={() => void inspectImages()}>{inspectingImage ? 'Analizando fotos en este computador…' : 'Volver a analizar las fotos'}</button>
        <p className="image-inspect-note">El análisis se inicia automáticamente al recibir cada foto. Se ejecuta localmente; la primera vez se descargan y guardan los datos de idioma de OCR.</p>
        {product.images.some((image) => image.inspection) && <div className="image-inspection-results"><strong>Qué se detectó en las fotos</strong>{product.images.map((image, index) => image.inspection && <section className="image-inspection-item" key={image.id}><span>Foto {index + 1}: {image.inspection.world.detected ? 'el análisis detectó un mundo; compruébalo en el original' : 'el análisis no confirmó el mundo'}</span>{image.inspection.codeCandidates.some((item) => item.confidence >= 0.6) ? <div className="image-code-candidates">{image.inspection.codeCandidates.filter((item) => item.confidence >= 0.6).map((item) => <button className={`candidate-chip ${shoeCode.toUpperCase() === item.code.toUpperCase() ? 'selected' : ''}`} key={`${image.id}-${item.code}`} onClick={() => setShoeCode(item.code)}>Usar código {item.code} · {Math.round(item.confidence * 100)}%</button>)}</div> : <small>{image.inspection.ocrError ? `No se pudo leer el texto de la foto: ${image.inspection.ocrError}` : product.shoe_code ? `No se identificó un código claro en la foto. Código para el marcado: ${product.shoe_code}.` : 'No se identificó un código claro en la foto ni en la descripción. Puedes escribirlo o pulsar Agregar solo código / Agregar ambos.'}</small>}<details><summary>Ver texto que detectó la imagen</summary><small>Confianza de lectura: {Math.round(image.inspection.ocrConfidence * 100)}%</small><pre>{image.inspection.ocrError ? `No se pudo leer el texto: ${image.inspection.ocrError}` : image.inspection.ocrText || 'No se reconoció texto.'}</pre></details></section>)}</div>}
        <label className="field-label spaced" htmlFor={`position-${product.id}`}>Esquina de la marca</label><select id={`position-${product.id}`} className="group-select" value={position} disabled={busy || editing || !canEdit} onChange={(event) => setPosition(event.target.value as OverlayPosition)}>{POSITIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><button className="secondary-button save-image-options" disabled={editing || busy || !canEdit || !imageOptionsDirty} onClick={() => void saveImageOptions()}>Actualizar vista previa marcada</button></div></div>
    </div>}
    <dialog ref={lightboxRef} className="image-lightbox" aria-label={lightbox?.label ?? 'Vista ampliada'} onClose={() => setLightbox(null)} onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}><button type="button" className="lightbox-close" aria-label="Cerrar fotografía" onClick={() => lightboxRef.current?.close()}>×</button>{lightbox && <><img src={lightbox.url} alt={lightbox.label} /><p>{lightbox.label}</p></>}</dialog>
  </article>;
}

function ActivityView({ logs, sessionName, onRefresh }: { logs: ApplicationLog[]; sessionName: string; onRefresh: () => void }) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [level, setLevel] = useState('all');
  const categoryNames: Record<string, string> = { products: 'Productos', suppliers: 'Proveedores', connection: 'Conexión', distribution: 'Envíos', settings: 'Configuración' };
  const levelNames: Record<string, string> = { info: 'Correcto', warning: 'Atención', error: 'Error' };
  const legacyMessages: Record<string, string> = {
    'product.received.whatsapp': 'Se recibió una publicación del proveedor',
    'product.price.prepared.automatically': 'Se reconoció el precio y se aplicó el margen del proveedor',
    'product.publication.queued': 'Se preparó una publicación para los grupos destino',
    'product.publication.submitted': 'Baileys aceptó una foto; confirma la entrega en WhatsApp',
    'product.approved': 'Se aprobó el precio y la descripción',
    'product.sent.manually': 'Se solicitó el envío de una referencia',
    'products.sent.in_bulk': 'Se ejecutó el envío masivo',
    'products.deleted.on_startup': 'Se limpió el catálogo al iniciar la aplicación',
    'products.deleted.manually': 'Se eliminaron productos enviados del catálogo',
    'product.simulated': 'Se registró una simulación local',
    'supplier.inbox.captured': 'Se guardó una publicación del proveedor fuera del catálogo',
    'supplier.history.requested': 'Se solicitó historial al teléfono', 'supplier.history.request.failed': 'Falló la solicitud de historial al teléfono', 'supplier.history.recovery.requested': 'Se inició otro intento de recuperar el rango guardado',
    'supplier.history.received': 'Baileys entregó mensajes del rango de recuperación',
    'product.received.outside_recovery_window': 'Se omitió una publicación fuera del día o rango de recuperación',
    'supplier.history.attempt.finished': 'Terminó el intento de recuperación del historial',
    'supplier.inbox.processing.failed': 'No se pudo procesar una publicación pendiente del proveedor',
    'supplier.reception.schedule.updated': 'Se actualizó el rango de recuperación del historial',
    'whatsapp.session.created': 'Se creó una cuenta de WhatsApp',
    'supplier.created': 'Se agregó un proveedor', 'supplier.updated': 'Se actualizaron las reglas del proveedor',
    'supplier.archived': 'Se archivó un proveedor', 'supplier.restored': 'Se reactivó un proveedor archivado', 'distribution.started': 'Se inició la distribución',
    'distribution.paused': 'Se pausó la distribución', 'distribution.stopped': 'Se detuvo la distribución',
  };
  const filtered = logs.filter((log) => {
    if (category !== 'all' && log.category !== category) return false;
    if (level !== 'all' && log.level !== level) return false;
    const needle = search.trim().toLocaleLowerCase('es');
    return !needle || `${log.message} ${log.entityName ?? ''} ${log.sessionName} ${log.action} ${JSON.stringify(log.details)}`.toLocaleLowerCase('es').includes(needle);
  });
  function detailsLabel(log: ApplicationLog) {
    const parts: string[] = [];
    const d = log.details ?? {};
    if (typeof d.imageCount === 'number' && d.imageCount > 0) parts.push(`${d.imageCount} ${d.imageCount === 1 ? 'fotografía' : 'fotografías'}`);
    if (Array.isArray(d.sourcePricesCop) && Array.isArray(d.marginsCop) && Array.isArray(d.finalPricesCop)
      && d.sourcePricesCop.length === d.marginsCop.length && d.sourcePricesCop.length === d.finalPricesCop.length
      && d.sourcePricesCop.every((value) => typeof value === 'number') && d.marginsCop.every((value) => typeof value === 'number') && d.finalPricesCop.every((value) => typeof value === 'number')) {
      const sources = d.sourcePricesCop as number[]; const margins = d.marginsCop as number[]; const finals = d.finalPricesCop as number[];
      parts.push(sources.map((source, index) => `${formatCop(source)} + ${formatCop(margins[index]!)} = ${formatCop(finals[index]!)}`).join(' · '));
    } else if (typeof d.sourcePriceCop === 'number' && typeof d.marginCop === 'number' && typeof d.finalPriceCop === 'number') parts.push(`${formatCop(d.sourcePriceCop)} + ${formatCop(d.marginCop)} = ${formatCop(d.finalPriceCop)}`);
    else if (typeof d.finalPriceCop === 'number') parts.push(`Precio de venta ${formatCop(d.finalPriceCop)}`);
    if (typeof d.targetCount === 'number') parts.push(`${d.targetCount} ${d.targetCount === 1 ? 'destino' : 'destinos'}`);
    if (typeof d.groupName === 'string') parts.push(d.groupName);
    if (typeof d.supplierName === 'string') parts.push(d.supplierName);
    if (typeof d.errorType === 'string') parts.push(`Detalle técnico: ${d.errorType}`);
    if (typeof d.statusCode === 'number') parts.push(`Código ${d.statusCode}`);
    return parts.join(' · ');
  }
  return <section className="panel activity-panel">
    <div className="catalog-header activity-header"><div><span className="panel-kicker">REGISTRO LOCAL · {sessionName.toLocaleUpperCase('es')}</span><h2>Actividad de la cuenta <span className="count-badge">{filtered.length}</span></h2></div><button className="icon-button" onClick={onRefresh} title="Actualizar historial">↻</button></div>
    <div className="activity-filters"><input aria-label="Buscar actividad" className="text-input" placeholder="Buscar en la actividad…" value={search} onChange={(event) => setSearch(event.target.value)} /><select className="group-select" aria-label="Filtrar por tipo" value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">Todos los tipos</option>{Object.entries(categoryNames).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select><select className="group-select" aria-label="Filtrar por estado" value={level} onChange={(event) => setLevel(event.target.value)}><option value="all">Todos los estados</option>{Object.entries(levelNames).map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></div>
    {filtered.length === 0 ? <div className="empty-state"><div className="empty-illustration">≋</div><h3>{logs.length ? 'No hay resultados con esos filtros' : 'Aún no hay actividad registrada'}</h3><p>{logs.length ? 'Prueba con otro término o cambia los filtros.' : 'Aquí aparecerán las fotos y descripciones recibidas, las revisiones, la conexión y el estado de cada envío.'}</p></div> : <div className="activity-list">{filtered.map((log) => {
      const detail = detailsLabel(log);
      const message = legacyMessages[log.action] && log.message === log.action ? legacyMessages[log.action] : log.message;
      return <article className={`activity-row activity-${log.level}`} key={log.id}><span className="activity-check">{log.level === 'error' ? '×' : log.level === 'warning' ? '!' : '✓'}</span><div className="activity-main"><strong>{message}</strong><span>{log.entityName ?? log.sessionName} <i>·</i> {categoryNames[log.category] ?? log.category} <i>·</i> {timeLabel(log.createdAt)}</span>{detail && <small>{detail}</small>}</div><span className={`activity-level ${log.level}`}>{levelNames[log.level] ?? log.level}</span></article>;
    })}</div>}
    <div className="activity-footer">Se muestran hasta 300 eventos recientes de la cuenta. “Baileys aceptó” confirma recepción por el conector, no la entrega final en WhatsApp.</div>
  </section>;
}
function SettingsView({ realSendsEnabled }: { realSendsEnabled: boolean }) {
  return <section className="settings-layout"><article className="panel settings-card"><div className="panel-title-row"><div><span className="panel-kicker">SEGURIDAD Y EJECUCIÓN</span><h2>Envío por confirmación</h2></div><span className="settings-icon">ⓘ</span></div><p className="panel-copy">{realSendsEnabled ? 'El envío real está habilitado en la configuración local. Solo se publica al pulsar el botón de envío individual o masivo y se utilizan los grupos destino seleccionados para la cuenta activa.' : 'El envío real está deshabilitado.'}</p><div className="settings-security"><span>ⓘ</span><p>Baileys es una integración no oficial de WhatsApp Web. No se implementan mecanismos para evadir controles. Usa cuentas y grupos autorizados; una restricción de WhatsApp puede interrumpir el servicio.</p></div><div className="settings-security"><span>⌑</span><p>La base y las fotos se guardan localmente. Las credenciales se cifran con Llavero de macOS o DPAPI de Windows. Protege también la carpeta de datos y las copias de respaldo.</p></div></article></section>;
}
