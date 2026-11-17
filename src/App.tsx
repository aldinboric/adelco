import {
  Archive,
  CheckCircle2,
  DatabaseBackup,
  FilePlus2,
  Layers,
  Menu,
  Palette,
  X,
  AlertCircle,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ConfirmModal } from './components/ConfirmModal';
import { CustomerQuoteView } from './components/CustomerQuoteView';
import { IssuedQuotesView } from './components/IssuedQuotesView';
import { MetalColorsView } from './components/MetalColorsView';
import { MetalProductsView } from './components/MetalProductsView';
import { QuotePrintModal } from './components/QuotePrintModal';
import { SettingsBackupModal } from './components/SettingsBackupModal';
import type {
  AppTab,
  IssuedQuoteDetail,
  MetalColor,
  MetalProduct,
  QuoteDraftItem,
  QuoteDraftState,
  ToastMessage,
} from './types';
import { centsToDollarsInput, todayIsoDate } from './utils/format';

function createEmptyDraft(): QuoteDraftState {
  return {
    customer_name: '',
    quote_date: todayIsoDate(),
    items: [],
    copiedFromQuoteNumber: null,
  };
}

interface CopyQuoteApiResponse {
  customer_name: string;
  quote_date: string;
  source_quote_number: string;
  items: Array<{
    product_id: number | null;
    color_id: number | null;
    linear_feet: number;
    additional_costs_cents: number;
    additional_costs_description: string;
    productIssue: 'unavailable' | 'deleted' | null;
    colorIssue: 'unavailable' | 'deleted' | null;
    fallbackProductName: string;
    fallbackProductImagePath: string | null;
    fallbackProductPriceCents: number;
    fallbackColorName: string;
    fallbackColorHex: string;
    fallbackColorPriceCents: number;
  }>;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>('quote');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [colors, setColors] = useState<MetalColor[]>([]);
  const [products, setProducts] = useState<MetalProduct[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);

  const [draft, setDraft] = useState<QuoteDraftState>(createEmptyDraft);
  const [pendingTabSwitch, setPendingTabSwitch] = useState<AppTab | null>(null);
  const [confirmClearDraftOpen, setConfirmClearDraftOpen] = useState(false);

  const [addColorModalOpen, setAddColorModalOpen] = useState(false);
  const [addProductModalOpen, setAddProductModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activePrintDetail, setActivePrintDetail] = useState<IssuedQuoteDetail | null>(null);
  const [quotesRefreshSignal, setQuotesRefreshSignal] = useState(0);

  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const notify = useCallback((type: 'success' | 'error', text: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, type, text }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4200);
  }, []);

  const loadCatalogs = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const [colorsRes, productsRes] = await Promise.all([
        fetch('/api/colors'),
        fetch('/api/products'),
      ]);
      if (!colorsRes.ok || !productsRes.ok) {
        throw new Error('Failed to load catalog data.');
      }
      const [colorsData, productsData] = await Promise.all([
        colorsRes.json() as Promise<MetalColor[]>,
        productsRes.json() as Promise<MetalProduct[]>,
      ]);
      setColors(colorsData);
      setProducts(productsData);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to load catalog.');
    } finally {
      setCatalogLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    loadCatalogs();
  }, [loadCatalogs]);

  const isDraftDirty = draft.items.length > 0 || draft.customer_name.trim() !== '';

  // Warn if closing browser tab with an unissued quote draft
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDraftDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDraftDirty]);

  const requestTabChange = (target: AppTab) => {
    setMobileMenuOpen(false);
    if (target === activeTab) return;
    if (activeTab === 'quote' && isDraftDirty) {
      setPendingTabSwitch(target);
      return;
    }
    setActiveTab(target);
  };

  const confirmLeaveDraft = () => {
    const target = pendingTabSwitch;
    setDraft(createEmptyDraft());
    setPendingTabSwitch(null);
    if (target) {
      setActiveTab(target);
    }
  };

  const handleQuoteIssued = (detail: IssuedQuoteDetail) => {
    setDraft(createEmptyDraft());
    setQuotesRefreshSignal((n) => n + 1);
    setActivePrintDetail(detail);
  };

  const handleCopyToNewQuote = async (quoteId: number) => {
    try {
      const res = await fetch(`/api/quotes/${quoteId}/copy`, { method: 'POST' });
      const data = (await res.json()) as CopyQuoteApiResponse & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to copy quote.');
      }

      const mappedItems: QuoteDraftItem[] = data.items.map((item, idx) => ({
        rowKey: `copied-${Date.now()}-${idx}`,
        product_id: item.product_id,
        color_id: item.color_id,
        linear_feet_input: String(item.linear_feet),
        additional_costs_input:
          item.additional_costs_cents > 0 ? centsToDollarsInput(item.additional_costs_cents) : '',
        additional_costs_description: item.additional_costs_description ?? '',
        productIssue: item.productIssue,
        colorIssue: item.colorIssue,
        fallbackProductName: item.fallbackProductName,
        fallbackProductImagePath: item.fallbackProductImagePath,
        fallbackProductPriceCents: item.fallbackProductPriceCents,
        fallbackColorName: item.fallbackColorName,
        fallbackColorHex: item.fallbackColorHex,
        fallbackColorPriceCents: item.fallbackColorPriceCents,
      }));

      setDraft({
        customer_name: data.customer_name,
        quote_date: data.quote_date,
        items: mappedItems,
        copiedFromQuoteNumber: data.source_quote_number,
      });
      setActivePrintDetail(null);
      setActiveTab('quote');
      notify('success', `Copied ${data.source_quote_number} into a new draft quote.`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to copy quote.');
    }
  };

  const handleRestored = async () => {
    setDraft(createEmptyDraft());
    await loadCatalogs();
    setQuotesRefreshSignal((n) => n + 1);
  };

  const navItems: Array<{ id: AppTab; label: string; icon: typeof FilePlus2 }> = [
    { id: 'quote', label: 'Customer Quote', icon: FilePlus2 },
    { id: 'issued', label: 'Issued Quotes', icon: Archive },
    { id: 'products', label: 'Products', icon: Layers },
    { id: 'colors', label: 'Colors', icon: Palette },
  ];

  const headerTitleMap: Record<AppTab, string> = {
    quote: 'Customer Quote',
    issued: 'Issued Quotes',
    products: 'Products',
    colors: 'Colors',
  };

  return (
    <div className="min-h-screen bg-[#f7f7f7] text-slate-900 flex">
      {/* Mobile Sidebar Backdrop */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Left Workspace Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white transition-transform duration-150 lg:static lg:translate-x-0 ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Company Brand Lockup */}
        <div className="flex h-16 items-center justify-between border-b border-slate-200 px-5">
          <div className="flex items-center gap-3 min-w-0">
            <img
              src="/assets/aistudio/Company_logo_1.0__Clean__no_black_shadow__bfc97f74.svg"
              alt="AdelCo Inc. Logo"
              className="h-9 w-9 shrink-0 object-contain"
            />
            <span className="truncate text-base font-bold tracking-tight text-[#084091] whitespace-nowrap">
              AdelCo Inc.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 lg:hidden"
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 4 Core Tables Navigation */}
        <nav className="flex-1 space-y-1 px-3 py-4" aria-label="Primary">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => requestTabChange(item.id)}
                className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm font-medium whitespace-nowrap transition-colors ${
                  active
                    ? 'bg-[#084091] text-white'
                    : 'text-slate-700 hover:bg-[#f7f7f7] hover:text-slate-900'
                }`}
              >
                <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-white' : 'text-slate-500'}`} />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Bottom Utility: Backup & Settings */}
        <div className="border-t border-slate-200 p-3">
          <button
            type="button"
            onClick={() => {
              setMobileMenuOpen(false);
              setSettingsOpen(true);
            }}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-[#f7f7f7] hover:text-slate-900 whitespace-nowrap transition-colors"
          >
            <DatabaseBackup className="h-4 w-4 shrink-0 text-[#2a6f3b]" />
            <span>Backup & Settings</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top Bar Contract: Breadcrumb/Title on left, 1 primary action on right */}
        <header className="flex h-16 shrink-0 items-center justify-between gap-8 border-b border-slate-200 bg-white px-6">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="rounded-md border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-50 lg:hidden"
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </button>
            <h1 className="text-base font-bold text-slate-900 truncate whitespace-nowrap">
              {headerTitleMap[activeTab]}
            </h1>
          </div>
        </header>

        {/* Active View Canvas */}
        <main className="flex-1 p-6">
          <div className="mx-auto max-w-[1280px]">
            {activeTab === 'quote' && (
              <CustomerQuoteView
                draft={draft}
                onChangeDraft={setDraft}
                products={products}
                colors={colors}
                onQuoteIssued={handleQuoteIssued}
                onClearDraftConfirmed={() => setConfirmClearDraftOpen(true)}
                onNotify={notify}
              />
            )}

            {activeTab === 'issued' && (
              <IssuedQuotesView
                onOpenQuoteDetail={setActivePrintDetail}
                onCopyToNewQuote={handleCopyToNewQuote}
                onStartNewQuote={() => setActiveTab('quote')}
                onNotify={notify}
                refreshSignal={quotesRefreshSignal}
              />
            )}

            {activeTab === 'products' && (
              <MetalProductsView
                products={products}
                loading={catalogLoading}
                onRefresh={loadCatalogs}
                onNotify={notify}
                modalOpenExternal={addProductModalOpen}
                onOpenAddExternal={() => setAddProductModalOpen(true)}
                onCloseModalExternal={() => setAddProductModalOpen(false)}
              />
            )}

            {activeTab === 'colors' && (
              <MetalColorsView
                colors={colors}
                loading={catalogLoading}
                onRefresh={loadCatalogs}
                onNotify={notify}
                modalOpenExternal={addColorModalOpen}
                onOpenAddExternal={() => setAddColorModalOpen(true)}
                onCloseModalExternal={() => setAddColorModalOpen(false)}
              />
            )}
          </div>
        </main>
      </div>

      {/* Modals */}
      <QuotePrintModal
        detail={activePrintDetail}
        onClose={() => setActivePrintDetail(null)}
        onCopyToNewQuote={handleCopyToNewQuote}
      />

      <SettingsBackupModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onRestored={handleRestored}
        onNotify={notify}
      />

      <ConfirmModal
        open={pendingTabSwitch !== null}
        title="Unsaved Quote Draft"
        message="You have an unissued quote in progress. If you leave Customer Quote now without issuing or exporting, your current draft items will be cleared. Leave anyway?"
        confirmLabel="Leave Without Saving"
        cancelLabel="Stay on Quote"
        tone="danger"
        onConfirm={confirmLeaveDraft}
        onCancel={() => setPendingTabSwitch(null)}
      />

      <ConfirmModal
        open={confirmClearDraftOpen}
        title="Clear Quote Draft?"
        message="Are you sure you want to clear all items and customer details from the current unissued quote?"
        confirmLabel="Clear Draft"
        tone="danger"
        onConfirm={() => {
          setDraft(createEmptyDraft());
          setConfirmClearDraftOpen(false);
        }}
        onCancel={() => setConfirmClearDraftOpen(false)}
      />

      {/* Toast Stack */}
      {toasts.length > 0 && (
        <div className="no-print fixed bottom-5 right-5 z-50 flex flex-col gap-2 max-w-sm">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`flex items-center gap-2.5 rounded-lg border px-4 py-3 text-xs font-medium shadow-lg ${
                t.type === 'success'
                  ? 'border-[#2a6f3b]/30 bg-white text-slate-900'
                  : 'border-red-300 bg-red-50 text-red-800'
              }`}
            >
              {t.type === 'success' ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-[#2a6f3b]" />
              ) : (
                <AlertCircle className="h-4 w-4 shrink-0 text-red-600" />
              )}
              <span>{t.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
