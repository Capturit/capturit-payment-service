// Types pour le catalogue unifié

export interface CatalogProduct {
  id: string;
  slug: string;
  name: string;
  description: string | null;

  // Catégorie
  category: 'web' | 'production' | 'alacarte';
  type: 'subscription' | 'one_time';

  // Prix (en centimes)
  price: number;
  monthlyPrice?: number;
  yearlyPrice?: number;
  setupFee?: number;
  currency: string;

  // Billing
  billingPeriod: 'monthly' | 'yearly' | 'one_time';

  // Stripe IDs
  stripeProductId: string | null;
  stripePriceId: string | null;

  // Affichage
  features: string[];
  isPopular: boolean;
  isCustom: boolean;
  displayOrder: number;

  // Status
  isActive: boolean;

  // Storage quota (pour clients)
  storageGb: number;
}

export interface CatalogResponse {
  success: boolean;
  data: CatalogProduct[];
  meta: {
    total: number;
    categories: {
      web: number;
      production: number;
      alacarte: number;
    };
  };
}

export interface SingleProductResponse {
  success: boolean;
  data: CatalogProduct;
}

export interface CategoryResponse {
  success: boolean;
  data: CatalogProduct[];
  meta: {
    total: number;
  };
}
