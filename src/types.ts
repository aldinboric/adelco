export type AppTab = 'quote' | 'issued' | 'products' | 'colors';

export interface MetalColor {
  id: number;
  name: string;
  hex_code: string;
  price_per_lf_cents: number;
  is_available: number;
  created_at: string;
}

export interface MetalProduct {
  id: number;
  name: string;
  image_path: string | null;
  price_per_lf_cents: number;
  is_available: number;
  created_at: string;
}

export interface QuoteDraftItem {
  rowKey: string;
  product_id: number | null;
  color_id: number | null;
  linear_feet_input: string;
  additional_costs_input: string;
  additional_costs_description: string;
  productIssue?: 'unavailable' | 'deleted' | null;
  colorIssue?: 'unavailable' | 'deleted' | null;
  fallbackProductName?: string;
  fallbackProductImagePath?: string | null;
  fallbackProductPriceCents?: number;
  fallbackColorName?: string;
  fallbackColorHex?: string;
  fallbackColorPriceCents?: number;
}

export interface QuoteDraftState {
  customer_name: string;
  quote_date: string;
  items: QuoteDraftItem[];
  copiedFromQuoteNumber?: string | null;
}

export interface IssuedQuote {
  id: number;
  quote_number: string;
  quote_date: string;
  customer_name: string | null;
  total_cents: number;
  created_by: string | null;
  created_at: string;
}

export interface IssuedQuoteItem {
  id: number;
  quote_id: number;
  source_product_id: number | null;
  source_color_id: number | null;
  product_name: string;
  product_image_path: string | null;
  color_name: string;
  color_hex: string;
  product_price_per_lf_cents: number;
  color_price_per_lf_cents: number;
  combined_price_per_lf_cents: number;
  linear_feet: number;
  additional_costs_cents: number;
  additional_costs_description: string | null;
  line_total_cents: number;
}

export interface IssuedQuoteDetail {
  quote: IssuedQuote;
  items: IssuedQuoteItem[];
}

export interface AppSettings {
  quote_prefix: string;
}

export interface ToastMessage {
  id: number;
  type: 'success' | 'error';
  text: string;
}
